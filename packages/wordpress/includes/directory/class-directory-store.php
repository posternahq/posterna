<?php
/**
 * Holds the current directory and keys, and refreshes them.
 *
 * @package Posterna
 */

namespace Posterna\Directory;

use Posterna\Verifier\Directory_Index;
use Posterna\Verifier\Index_Builder;

defined( 'ABSPATH' ) || exit;

/**
 * A port of packages/core/src/directory/store.ts (docs/SPEC.md sections 3.1
 * and 3.4). Starts from the bundled snapshot; refreshes download a file and
 * its .sig, accept it only under a trusted key at or above the minimum
 * generation, refuse older versions at the same generation, and keep the
 * last good copy on any failure. Refreshes never run on the request path.
 *
 * One difference from core: the generation ratchet is saved with the rest of
 * the state, because each WordPress request is its own process.
 */
final class Directory_Store {

	const DIRECTORY_VERSION = '/^\d{4}-\d{2}-\d{2}$/';
	const KEYS_VERSION      = '/^\d{4}-\d{2}-\d{2}T\d{2}$/';
	const MAX_FILE_BYTES    = 20971520;
	const EARLY_KEYS_GAP_MS = 600000;

	/**
	 * Options.
	 *
	 * @var array
	 */
	private $options;

	/**
	 * Saved state.
	 *
	 * @var Directory_Storage
	 */
	private $storage;

	/**
	 * Current state, or null before anything loaded.
	 *
	 * @var array|null
	 */
	private $state = null;

	/**
	 * The index built from the state.
	 *
	 * @var Directory_Index|null
	 */
	private $index = null;

	/**
	 * Failures in this process: snapshot load and rejected refreshes.
	 *
	 * @var int
	 */
	public $errors = 0;

	/**
	 * The last failure.
	 *
	 * @var string|null
	 */
	public $last_error = null;

	/**
	 * Rejected refreshes by reason, in this process.
	 *
	 * @var array
	 */
	public $refresh_failures = array();

	/**
	 * Lowest generation in the trusted list; the bundled snapshot counts as signed at it.
	 *
	 * @var int|null
	 */
	private $base_generation = null;

	/**
	 * Creates the store.
	 *
	 * @param Directory_Storage $storage Storage.
	 * @param array             $options array( 'snapshot' => callable(): array( 'directory', 'keys' ),
	 *                                   'refresh' => bool, 'trusted_keys' => array, 'base_url' => string,
	 *                                   'fetch' => callable( string $url ): array( 'status', 'body' ),
	 *                                   'now' => callable(): ms, 'on_keys_refresh' => callable|null ).
	 */
	public function __construct( $storage, $options ) {
		$this->storage             = $storage;
		$this->options             = array_merge(
			array(
				'snapshot'        => null,
				'refresh'         => false,
				'trusted_keys'    => null,
				'base_url'        => 'https://posterna.com/v1/',
				'fetch'           => null,
				'now'             => function () {
					return microtime( true ) * 1000;
				},
				'on_keys_refresh' => null,
			),
			$options
		);
		$this->options['base_url'] = rtrim( (string) $this->options['base_url'], '/' ) . '/';
	}

	/**
	 * The trusted keys: those passed in, else the embedded ones (loaded only when needed).
	 *
	 * @return array
	 */
	private function trusted_keys() {
		if ( null === $this->options['trusted_keys'] ) {
			$this->options['trusted_keys'] = Trusted_Keys::all();
		}
		return $this->options['trusted_keys'];
	}

	/**
	 * The lowest generation in the trusted list; the bundled snapshot counts as signed at it.
	 *
	 * @return int
	 */
	private function base_generation() {
		if ( null === $this->base_generation ) {
			$generations = array();
			foreach ( $this->trusted_keys() as $key ) {
				if ( isset( $key['generation'] ) && is_int( $key['generation'] ) && $key['generation'] > 0 ) {
					$generations[] = $key['generation'];
				}
			}
			$this->base_generation = array() === $generations ? 0 : min( $generations );
		}
		return $this->base_generation;
	}

	/**
	 * Loads the saved state, or compiles the bundled snapshot when there is none
	 * (or $from_snapshot is true). Never throws.
	 *
	 * @param bool $from_snapshot Recompile from the snapshot even when a state is saved.
	 */
	public function load( $from_snapshot = false ) {
		$this->index = null;
		$saved       = $from_snapshot ? null : $this->storage->get_state();
		if ( is_array( $saved ) && isset( $saved['directory'] ) && is_array( $saved['directory'] ) ) {
			$this->state = $saved;
			return;
		}
		// A snapshot that failed to load is not retried on every request, only after an hour.
		$now = call_user_func( $this->options['now'] );
		if ( is_array( $saved ) && isset( $saved['failed_at'] ) && is_numeric( $now ) && $now - $saved['failed_at'] < 3600000 ) {
			$this->state = null;
			++$this->errors;
			$this->last_error = isset( $saved['failed_error'] ) ? (string) $saved['failed_error'] : 'loading the directory snapshot failed';
			return;
		}
		try {
			$files    = call_user_func( $this->options['snapshot'] );
			$compiled = Index_Builder::compile_directory( $files['directory'] );
			$keys     = ( isset( $files['keys'] ) && null !== $files['keys'] ) ? Index_Builder::compile_keys( $files['keys'] ) : null;
			// Recompiling never lowers the ratchet.
			$previous    = $this->storage->get_state();
			$floor       = is_array( $previous ) && isset( $previous['floor'] ) ? (int) $previous['floor'] : 0;
			$this->state = array(
				'directory'            => $compiled['directory'],
				'keys'                 => $keys,
				'directory_generation' => $this->base_generation(),
				'keys_generation'      => $this->base_generation(),
				'floor'                => $floor,
				'source'               => 'bundled',
				'last_early_keys'      => null,
			);
			$this->storage->put_ranges( $compiled['ranges'] );
			$this->storage->put_state( $this->state );
		} catch ( \Throwable $error ) {
			$this->state = null;
			$this->fail( 'loading the directory snapshot', $error );
			try {
				$this->storage->put_state(
					array(
						'directory'    => null,
						'keys'         => null,
						'floor'        => is_array( $saved ) && isset( $saved['floor'] ) ? (int) $saved['floor'] : 0,
						'failed_at'    => is_numeric( $now ) ? $now : 0,
						'failed_error' => $this->last_error,
					)
				);
			} catch ( \Throwable $ignored ) {
				// Nothing more to do; the next request tries again.
				unset( $ignored );
			}
		}
	}

	/**
	 * The current state, or null.
	 *
	 * @return array|null
	 */
	public function state() {
		return $this->state;
	}

	/**
	 * The index requests use, or null when nothing loaded.
	 *
	 * @return Directory_Index|null
	 */
	public function index() {
		if ( null === $this->index && null !== $this->state && is_array( $this->state['directory'] ) ) {
			$storage     = $this->storage;
			$this->index = new Directory_Index(
				$this->state['directory'],
				$this->state['keys'],
				function ( $slug ) use ( $storage ) {
					return $storage->get_ranges( $slug );
				}
			);
		}
		return $this->index;
	}

	/**
	 * True when refresh is on and at least one trusted key is configured.
	 *
	 * @return bool
	 */
	public function refresh_enabled() {
		return (bool) $this->options['refresh'] && array() !== $this->trusted_keys();
	}

	/**
	 * The lowest signing generation still accepted.
	 *
	 * @return int
	 */
	public function min_generation() {
		$floor = null === $this->state ? 0 : (int) $this->state['floor'];
		return max( $this->base_generation(), $floor );
	}

	/**
	 * Records a failure.
	 *
	 * @param string     $context What was being done.
	 * @param \Throwable $error   Error.
	 */
	private function fail( $context, $error ) {
		++$this->errors;
		$this->last_error = $context . ': ' . $error->getMessage();
	}

	/**
	 * Records a rejected refresh.
	 *
	 * @param string     $file  File name.
	 * @param \Throwable $error Error.
	 */
	private function reject( $file, $error ) {
		$reason                            = $error instanceof Refresh_Rejected ? $error->reason : 'invalid_file';
		$this->refresh_failures[ $reason ] = ( isset( $this->refresh_failures[ $reason ] ) ? $this->refresh_failures[ $reason ] : 0 ) + 1;
		$this->fail( 'refreshing ' . $file . ': ' . $reason, $error );
	}

	/**
	 * Asks for an early keys.json refresh after an unknown kid. At most one per
	 * 10 minutes; the on_keys_refresh callback decides when it runs.
	 *
	 * @return bool True when one was requested.
	 */
	public function request_keys_refresh() {
		if ( ! $this->refresh_enabled() || null === $this->state ) {
			return false;
		}
		$now  = call_user_func( $this->options['now'] );
		$last = isset( $this->state['last_early_keys'] ) ? $this->state['last_early_keys'] : null;
		if ( null !== $last && $now - $last < self::EARLY_KEYS_GAP_MS ) {
			return false;
		}
		$this->state['last_early_keys'] = $now;
		try {
			$this->storage->put_state( $this->state );
		} catch ( \Throwable $error ) {
			$this->fail( 'saving the directory state', $error );
		}
		if ( is_callable( $this->options['on_keys_refresh'] ) ) {
			call_user_func( $this->options['on_keys_refresh'] );
		}
		return true;
	}

	/**
	 * Downloads one file.
	 *
	 * @param string $name File name under the base URL.
	 * @return string Body.
	 * @throws \RuntimeException On any failure.
	 */
	private function download( $name ) {
		if ( ! is_callable( $this->options['fetch'] ) ) {
			$exception = new \RuntimeException( 'no fetch available' );
			throw $exception;
		}
		$response = call_user_func( $this->options['fetch'], $this->options['base_url'] . $name );
		$status   = isset( $response['status'] ) ? (int) $response['status'] : 0;
		if ( $status < 200 || $status > 299 ) {
			$exception = new \RuntimeException( $name . ': HTTP ' . $status );
			throw $exception;
		}
		$body = isset( $response['body'] ) ? (string) $response['body'] : '';
		if ( strlen( $body ) > self::MAX_FILE_BYTES ) {
			$exception = new \RuntimeException( $name . ': larger than ' . self::MAX_FILE_BYTES . ' bytes' );
			throw $exception;
		}
		return $body;
	}

	/**
	 * Downloads a file and its .sig and returns the parsed JSON with its
	 * signing generation, only if the signature verifies. Raises the minimum
	 * generation (the ratchet).
	 *
	 * @param string $name File name.
	 * @return array array( value, generation ).
	 * @throws Refresh_Rejected When it is not accepted.
	 */
	private function signed_file( $name ) {
		// Both downloads are attempted, as core starts them together.
		$body      = null;
		$signature = null;
		$failure   = null;
		try {
			$body = $this->download( $name );
		} catch ( \Throwable $error ) {
			$failure = $error;
		}
		try {
			$signature = $this->download( $name . '.sig' );
		} catch ( \Throwable $error ) {
			$failure = null === $failure ? $error : $failure;
		}
		if ( null !== $failure ) {
			$exception = new Refresh_Rejected( 'download_failed', $failure->getMessage() );
			throw $exception;
		}
		$minimum = $this->min_generation();
		$check   = Directory_Signature::check( $body, $signature, $this->trusted_keys(), $minimum );
		if ( ! $check['ok'] ) {
			$exception = new Refresh_Rejected(
				$check['reason'],
				'signature_retired' === $check['reason']
					? $name . ': signed by a key below generation ' . $minimum . ', which this install no longer trusts'
					: $name . ': signature does not verify against the trusted keys'
			);
			throw $exception;
		}
		if ( $check['generation'] > (int) $this->state['floor'] ) {
			$this->state['floor'] = $check['generation'];
		}
		$value = json_decode( $body, true );
		if ( null === $value && 'null' !== trim( $body ) ) {
			$exception = new Refresh_Rejected( 'invalid_file', $name . ': not valid JSON' );
			throw $exception;
		}
		return array( $value, $check['generation'] );
	}

	/**
	 * Anti-rollback: a file signed at the same generation as the loaded copy
	 * must not have an older version. A higher generation replaces the loaded
	 * copy whatever its version.
	 *
	 * @param string     $name       File name.
	 * @param string     $pattern    Version pattern.
	 * @param mixed      $version    The new file's version.
	 * @param int        $generation The new file's generation.
	 * @param array|null $loaded     array( version, generation ) of the loaded copy.
	 * @throws Refresh_Rejected When it is not accepted.
	 */
	private static function check_version( $name, $pattern, $version, $generation, $loaded ) {
		if ( ! is_string( $version ) || ! preg_match( $pattern, $version ) ) {
			$exception = new Refresh_Rejected( 'invalid_file', $name . ': version is missing or malformed' );
			throw $exception;
		}
		if ( null === $loaded || $generation > $loaded[1] ) {
			return;
		}
		if ( is_string( $loaded[0] ) && preg_match( $pattern, $loaded[0] ) && strcmp( $version, $loaded[0] ) < 0 ) {
			$exception = new Refresh_Rejected( 'version_rollback', $name . ': version ' . $version . ' is older than the loaded ' . $loaded[0] );
			throw $exception;
		}
	}

	/**
	 * Throws a rejection.
	 *
	 * @param string $reason  Reason code.
	 * @param string $message Message.
	 * @throws Refresh_Rejected Always.
	 */
	private static function rejected( $reason, $message ) {
		$exception = new Refresh_Rejected( $reason, $message );
		throw $exception;
	}

	/**
	 * Saves the state after a change. A save failure is recorded, never thrown.
	 */
	private function save() {
		try {
			$this->storage->put_state( $this->state );
		} catch ( \Throwable $error ) {
			$this->fail( 'saving the directory state', $error );
		}
	}

	/**
	 * Refreshes directory.json now. Keeps the last good copy on any failure.
	 *
	 * @return bool
	 */
	public function refresh_directory() {
		if ( null === $this->state ) {
			$this->state = array(
				'directory'            => null,
				'keys'                 => null,
				'directory_generation' => $this->base_generation(),
				'keys_generation'      => $this->base_generation(),
				'floor'                => 0,
				'source'               => 'none',
				'last_early_keys'      => null,
			);
		}
		try {
			list( $value, $generation ) = $this->signed_file( 'directory.json' );
			try {
				Index_Builder::check_directory_shape( $value );
			} catch ( \Throwable $error ) {
				self::rejected( 'invalid_file', 'directory.json: ' . $error->getMessage() );
			}
			$loaded = is_array( $this->state['directory'] ) ? array( $this->state['directory']['version'], $this->state['directory_generation'] ) : null;
			self::check_version( 'directory.json', self::DIRECTORY_VERSION, isset( $value['version'] ) ? $value['version'] : null, $generation, $loaded );
			try {
				$compiled = Index_Builder::compile_directory( $value );
			} catch ( \Throwable $error ) {
				self::rejected( 'invalid_file', 'directory.json: ' . $error->getMessage() );
			}
			$this->storage->put_ranges( $compiled['ranges'] );
			$this->state['directory']            = $compiled['directory'];
			$this->state['directory_generation'] = $generation;
			$this->state['source']               = 'downloaded';
			$this->index                         = null;
			$this->save();
			return true;
		} catch ( \Throwable $error ) {
			$this->save();
			$this->reject( 'directory.json', $error );
			return false;
		}
	}

	/**
	 * Refreshes keys.json now. Keeps the last good copy on any failure.
	 *
	 * @return bool
	 */
	public function refresh_keys() {
		if ( null === $this->state ) {
			$this->state = array(
				'directory'            => null,
				'keys'                 => null,
				'directory_generation' => $this->base_generation(),
				'keys_generation'      => $this->base_generation(),
				'floor'                => 0,
				'source'               => 'none',
				'last_early_keys'      => null,
			);
		}
		try {
			list( $value, $generation ) = $this->signed_file( 'keys.json' );
			try {
				Index_Builder::check_keys_shape( $value );
			} catch ( \Throwable $error ) {
				self::rejected( 'invalid_file', 'keys.json: ' . $error->getMessage() );
			}
			$loaded = is_array( $this->state['keys'] ) ? array( $this->state['keys']['version'], $this->state['keys_generation'] ) : null;
			self::check_version( 'keys.json', self::KEYS_VERSION, isset( $value['version'] ) ? $value['version'] : null, $generation, $loaded );
			if ( ! is_array( $this->state['directory'] ) ) {
				self::rejected( 'directory_missing', 'no directory loaded to attach keys to' );
			}
			try {
				$compiled = Index_Builder::compile_keys( $value );
			} catch ( \Throwable $error ) {
				self::rejected( 'invalid_file', 'keys.json: ' . $error->getMessage() );
			}
			$this->state['keys']            = $compiled;
			$this->state['keys_generation'] = $generation;
			$this->index                    = null;
			$this->save();
			return true;
		} catch ( \Throwable $error ) {
			$this->save();
			$this->reject( 'keys.json', $error );
			return false;
		}
	}
}
