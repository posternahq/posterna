<?php
/**
 * Forward-confirmed reverse DNS that never runs on the request path.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * A port of packages/core/src/verifier/rdns.ts (docs/SPEC.md section 4.5).
 * The first request from an address queues a lookup and is labeled pending;
 * the lookup runs later (in WP-Cron in the plugin), and later requests read
 * the cached result.
 */
final class Rdns_Cache {

	const MAX_NAMES = 3;

	const DEFAULTS = array(
		'timeoutMs'     => 1000,
		'positiveTtlMs' => 86400000,
		'negativeTtlMs' => 3600000,
		'errorTtlMs'    => 60000,
	);

	/**
	 * Resolver, or null where there is no DNS.
	 *
	 * @var Dns_Resolver|null
	 */
	private $resolver;

	/**
	 * Timings, as in core.
	 *
	 * @var array
	 */
	private $options;

	/**
	 * Clock in milliseconds.
	 *
	 * @var callable
	 */
	private $now;

	/**
	 * Storage.
	 *
	 * @var Rdns_Store
	 */
	private $store;

	/**
	 * Lookups that failed in this process.
	 *
	 * @var int
	 */
	public $errors = 0;

	/**
	 * The last lookup error.
	 *
	 * @var string|null
	 */
	public $last_error = null;

	/**
	 * Creates the cache.
	 *
	 * @param Dns_Resolver|null $resolver Resolver.
	 * @param array             $options  Timings (keys as in DEFAULTS).
	 * @param callable          $now      Clock in milliseconds.
	 * @param Rdns_Store        $store    Storage.
	 */
	public function __construct( $resolver, $options, $now, $store ) {
		$this->resolver = $resolver;
		$this->options  = array_merge( self::DEFAULTS, (array) $options );
		$this->now      = $now;
		$this->store    = $store;
	}

	/**
	 * True when reverse DNS can run here.
	 *
	 * @return bool
	 */
	public function available() {
		return null !== $this->resolver;
	}

	/**
	 * The current entry for an address, or null when there is none or it expired.
	 *
	 * @param string $ip Address.
	 * @return array|null
	 */
	public function get( $ip ) {
		$entry = $this->store->get( $ip );
		if ( ! is_array( $entry ) || ! isset( $entry['status'] ) ) {
			return null;
		}
		if ( 'pending' !== $entry['status'] && ( ! isset( $entry['expires_at'] ) || $entry['expires_at'] <= call_user_func( $this->now ) ) ) {
			return null;
		}
		return $entry;
	}

	/**
	 * Queues a lookup for an address unless one is cached or queued.
	 *
	 * @param string $ip Address.
	 */
	public function schedule( $ip ) {
		if ( null === $this->resolver || null !== $this->get( $ip ) ) {
			return;
		}
		$this->store->set( $ip, array( 'status' => 'pending' ), 600 );
		$this->store->enqueue( $ip );
	}

	/**
	 * Runs queued lookups.
	 *
	 * @param int   $limit         Most addresses to look up (0 for all).
	 * @param float $budget_seconds Stop starting new lookups after this long (0 for no limit).
	 * @return int Lookups run.
	 */
	public function settle( $limit = 0, $budget_seconds = 0.0 ) {
		$started = microtime( true );
		$done    = 0;
		$queue   = $this->store->dequeue( $limit );
		foreach ( $queue as $position => $ip ) {
			if ( $budget_seconds > 0 && microtime( true ) - $started > $budget_seconds ) {
				// Out of time: put the rest back for the next run.
				foreach ( array_slice( $queue, $position ) as $rest ) {
					$this->store->enqueue( $rest );
				}
				break;
			}
			$this->lookup( $ip );
			++$done;
		}
		return $done;
	}

	/**
	 * Looks up one address and stores the result.
	 *
	 * @param string $ip Address.
	 */
	private function lookup( $ip ) {
		if ( null === $this->resolver ) {
			return;
		}
		$timeout = (int) $this->options['timeoutMs'];
		$started = microtime( true );
		try {
			$confirmed = $this->confirm( $ip );
			// PHP cannot interrupt a DNS call, so a slow answer counts as a timeout, as in core.
			if ( ( microtime( true ) - $started ) * 1000 > $timeout ) {
				$this->record_error( $ip, 'timed out after ' . $timeout . ' ms' );
				return;
			}
			$now = call_user_func( $this->now );
			if ( array() !== $confirmed ) {
				$ttl = (int) $this->options['positiveTtlMs'];
				$this->store->set(
					$ip,
					array(
						'status'     => 'confirmed',
						'hostnames'  => $confirmed,
						'expires_at' => $now + $ttl,
					),
					(int) ceil( $ttl / 1000 )
				);
			} else {
				$ttl = (int) $this->options['negativeTtlMs'];
				$this->store->set(
					$ip,
					array(
						'status'     => 'unconfirmed',
						'expires_at' => $now + $ttl,
					),
					(int) ceil( $ttl / 1000 )
				);
			}
		} catch ( \Throwable $error ) {
			$this->record_error( $ip, $error->getMessage() );
		}
	}

	/**
	 * Remembers a failed lookup for a minute.
	 *
	 * @param string $ip      Address.
	 * @param string $message What failed.
	 */
	private function record_error( $ip, $message ) {
		++$this->errors;
		$this->last_error = 'reverse DNS: ' . $message;
		$ttl              = (int) $this->options['errorTtlMs'];
		$this->store->set(
			$ip,
			array(
				'status'     => 'error',
				'message'    => $message,
				'expires_at' => call_user_func( $this->now ) + $ttl,
			),
			max( 1, (int) ceil( $ttl / 1000 ) )
		);
	}

	/**
	 * PTR names that resolve forward to the same address.
	 *
	 * @param string $ip Address.
	 * @return array Lowercase names without the trailing dot.
	 */
	private function confirm( $ip ) {
		$target = Address::parse( $ip );
		$target = null === $target ? null : $target->text;
		$names  = array();
		foreach ( $this->resolver->reverse( $ip ) as $name ) {
			$name = rtrim( strtolower( (string) $name ), '.' );
			if ( '' !== $name ) {
				$names[] = $name;
			}
			if ( count( $names ) >= self::MAX_NAMES ) {
				break;
			}
		}
		$confirmed = array();
		foreach ( $names as $name ) {
			foreach ( $this->resolver->forward( $name ) as $address ) {
				$parsed = Address::parse( (string) $address );
				if ( null !== $parsed && $parsed->text === $target ) {
					$confirmed[] = $name;
					break;
				}
			}
		}
		return $confirmed;
	}

	/**
	 * True when a hostname is one of the suffixes or inside one of them.
	 *
	 * @param string $hostname Lowercase name.
	 * @param array  $suffixes Suffixes.
	 * @return bool
	 */
	public static function matches_suffix( $hostname, $suffixes ) {
		foreach ( $suffixes as $suffix ) {
			$lower = trim( strtolower( (string) $suffix ), '.' );
			if ( $hostname === $lower || substr( $hostname, -strlen( '.' . $lower ) ) === '.' . $lower ) {
				return true;
			}
		}
		return false;
	}
}
