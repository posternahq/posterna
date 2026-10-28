<?php
/**
 * Labels one request (docs/SPEC.md section 4).
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

use Posterna\Directory\Directory_Store;
use Posterna\Signature\Default_Signature_Library;
use Posterna\Signature\Signature_Path;

defined( 'ABSPATH' ) || exit;

/**
 * A port of packages/core/src/verifier/verifier.ts. verify() never throws and
 * never waits on the network: reverse DNS and directory refreshes run
 * elsewhere, and every error path fails open (docs/SPEC.md section 4.8).
 *
 * A result is an array with 'verdict' and, when set, 'operator', 'agent',
 * 'purpose', 'method', 'reason', 'note' and 'error'.
 */
final class Verifier {

	const DEFAULT_MAX_SIGNATURE_VALIDITY = 3600;

	const VERDICTS = array( 'verified_by_signature', 'verified_by_ip', 'declared_unverifiable', 'claimed_failed', 'unknown_automation', 'human' );

	const REASON_CODES = array(
		'signature_invalid',
		'expired',
		'created_in_future',
		'validity_too_long',
		'nonce_replayed',
		'nonce_rejected',
		'profile_rejected',
		'malformed_signature',
		'unknown_kid',
		'no_keys',
		'unsigned',
		'unlisted_signature_agent',
		'outside_ip_list',
		'rdns_mismatch',
		'rdns_unconfirmed',
		'rdns_pending',
		'no_dns',
		'no_client_address',
		'nothing_published',
		'community_token_on_browser',
		'no_user_agent',
		'non_browser_user_agent',
		'automation_token',
		'missing_accept',
		'missing_accept_language',
		'directory_unavailable',
		'clock_invalid',
		'rdns_error',
		'library_unsupported',
		'library_error',
		'unexpected_error',
	);

	/**
	 * Reason codes of fail-open paths.
	 */
	const FAIL_OPEN_REASONS = array( 'directory_unavailable', 'clock_invalid', 'rdns_error', 'library_unsupported', 'library_error', 'unexpected_error' );

	/**
	 * Directory.
	 *
	 * @var Directory_Store
	 */
	private $store;

	/**
	 * Client resolution.
	 *
	 * @var Client_Resolver
	 */
	private $resolver;

	/**
	 * Proxy guard.
	 *
	 * @var Proxy_Guard
	 */
	private $guard;

	/**
	 * Nonce store, or a callable that creates it on first use.
	 *
	 * @var Nonce_Store|callable
	 */
	private $nonces;

	/**
	 * Reverse DNS, or a callable that creates it on first use.
	 *
	 * @var Rdns_Cache|callable
	 */
	private $rdns;

	/**
	 * Signature functions, created on first use.
	 *
	 * @var \Posterna\Signature\Signature_Library|null
	 */
	private $library;

	/**
	 * Clock in milliseconds.
	 *
	 * @var callable
	 */
	private $now;

	/**
	 * Clock skew in seconds.
	 *
	 * @var int
	 */
	private $clock_skew;

	/**
	 * Longest signature validity window in seconds.
	 *
	 * @var int
	 */
	private $max_validity;

	/**
	 * Fail-open paths taken in this process.
	 *
	 * @var int
	 */
	public $errors = 0;

	/**
	 * The last fail-open message.
	 *
	 * @var string|null
	 */
	public $last_error = null;

	/**
	 * Creates a verifier.
	 *
	 * @param Directory_Store      $store   Directory.
	 * @param Rdns_Cache|callable  $rdns    Reverse DNS, or a callable that creates it when first needed.
	 * @param Nonce_Store|callable $nonces  Nonces, or a callable that creates them when first needed.
	 * @param array                $options Proxy options as in core (clientIpHeader, trustedProxies,
	 *                                      forwardedHeader, publicHost, trustForwardedHost), plus clockSkew,
	 *                                      maxSignatureValidity, now (ms clock), signatureLibrary, guard.
	 */
	public function __construct( $store, $rdns, $nonces, $options = array() ) {
		$this->store        = $store;
		$this->rdns         = $rdns;
		$this->nonces       = $nonces;
		$this->resolver     = new Client_Resolver( $options );
		$this->guard        = isset( $options['guard'] ) ? $options['guard'] : new Proxy_Guard();
		$this->library      = isset( $options['signatureLibrary'] ) ? $options['signatureLibrary'] : null;
		$this->now          = isset( $options['now'] ) ? $options['now'] : function () {
			return microtime( true ) * 1000;
		};
		$this->clock_skew   = isset( $options['clockSkew'] ) ? (int) $options['clockSkew'] : 60;
		$this->max_validity = isset( $options['maxSignatureValidity'] ) ? (int) $options['maxSignatureValidity'] : self::DEFAULT_MAX_SIGNATURE_VALIDITY;
	}

	/**
	 * Reverse DNS, created on first use.
	 *
	 * @return Rdns_Cache
	 */
	private function rdns() {
		if ( ! $this->rdns instanceof Rdns_Cache ) {
			$this->rdns = call_user_func( $this->rdns );
		}
		return $this->rdns;
	}

	/**
	 * The nonce store, created on first use.
	 *
	 * @return Nonce_Store
	 */
	private function nonces() {
		if ( ! $this->nonces instanceof Nonce_Store ) {
			$this->nonces = call_user_func( $this->nonces );
		}
		return $this->nonces;
	}

	/**
	 * Labels one request. Never throws.
	 *
	 * @param Request $request Request.
	 * @return array Result.
	 */
	public function verify( $request ) {
		try {
			return $this->label( $request );
		} catch ( \Throwable $error ) {
			return $this->fail_open( $request, 'unexpected error: ' . $error->getMessage(), 'unexpected_error' );
		}
	}

	/**
	 * Client address and host resolution for one request.
	 *
	 * @param Request $request Request.
	 * @return array See Client_Resolver::resolve().
	 */
	public function resolve( $request ) {
		return $this->resolver->resolve( $request );
	}

	/**
	 * What the verifier knows about itself.
	 *
	 * @return array
	 */
	public function state() {
		$index = $this->store->index();
		return array(
			'ready'                  => null !== $index,
			'proxySuspect'           => $this->guard->suspect(),
			'errors'                 => $this->errors + $this->store->errors + $this->rdns()->errors,
			'lastError'              => null !== $this->last_error ? $this->last_error : ( null !== $this->store->last_error ? $this->store->last_error : $this->rdns()->last_error ),
			'directoryVersion'       => null === $index ? null : $index->directory_version(),
			'keysVersion'            => null === $index ? null : $index->keys_version(),
			'directoryKeyGeneration' => $this->store->refresh_enabled() ? $this->store->min_generation() : null,
			'reverseDnsAvailable'    => $this->rdns()->available(),
		);
	}

	/**
	 * The headers that carry a verdict to the application. Fields without a
	 * value are left out rather than sent empty.
	 *
	 * @param array $result Result.
	 * @return array Header name => value.
	 */
	public static function verdict_headers( $result ) {
		$headers = array( 'X-Agent-Verdict' => $result['verdict'] );
		if ( ! empty( $result['operator'] ) ) {
			$headers['X-Agent-Operator'] = $result['operator'];
		}
		if ( ! empty( $result['purpose'] ) ) {
			$headers['X-Agent-Purpose'] = $result['purpose'];
		}
		$headers['X-Agent-Method'] = isset( $result['method'] ) ? $result['method'] : 'none';
		return $headers;
	}

	/**
	 * The request proceeds unlabeled: unknown_automation if it looked
	 * automated, else human, with the error set.
	 *
	 * @param Request|null $request Request.
	 * @param string       $message What went wrong.
	 * @param string       $reason  Reason code.
	 * @return array
	 */
	private function fail_open( $request, $message, $reason ) {
		++$this->errors;
		$this->last_error = $message;
		$automated        = true;
		try {
			$automated = null === $request || null !== Automation::signal( $request );
		} catch ( \Throwable $error ) {
			$automated = true;
		}
		return array(
			'verdict' => $automated ? 'unknown_automation' : 'human',
			'method'  => 'none',
			'reason'  => $reason,
			'note'    => 'A fail-open path was taken; the request proceeds unlabeled.',
			'error'   => $message,
		);
	}

	/**
	 * The operator and agent fields of a result.
	 *
	 * @param string     $verdict Verdict.
	 * @param string     $slug    Operator slug.
	 * @param array|null $agent   Agent record.
	 * @param array      $extra   Other fields.
	 * @return array
	 */
	private static function result( $verdict, $slug, $agent, $extra ) {
		$result = array(
			'verdict'  => $verdict,
			'operator' => $slug,
		);
		if ( null !== $agent ) {
			$result['agent'] = $agent['name'];
			if ( null !== $agent['purpose'] ) {
				$result['purpose'] = $agent['purpose'];
			}
		}
		return array_merge( $result, $extra );
	}

	/**
	 * The agent a verified signature speaks for: the one the User-Agent names,
	 * else the only signing one, else the first one the operator's signing covers.
	 *
	 * @param Directory_Index $index      Directory.
	 * @param string          $slug       Operator.
	 * @param array|null      $user_agent array( slug, position ) from the User-Agent.
	 * @return array|null
	 */
	private static function signing_agent( $index, $slug, $user_agent ) {
		$operator = $index->operator( $slug );
		if ( null === $operator ) {
			return null;
		}
		if ( null !== $user_agent && $user_agent[0] === $slug ) {
			return $operator['agents'][ $user_agent[1] ];
		}
		$signing = array();
		foreach ( $operator['agents'] as $agent ) {
			if ( $agent['signs'] ) {
				$signing[] = $agent;
			}
		}
		if ( 1 === count( $signing ) ) {
			return $signing[0];
		}
		foreach ( $operator['agents'] as $agent ) {
			if ( in_array( $agent['name'], $operator['covers'], true ) ) {
				return $agent;
			}
		}
		return null;
	}

	/**
	 * IP list and reverse DNS checks for a User-Agent claim (docs/SPEC.md section 4.5).
	 *
	 * @param Directory_Index $index   Directory.
	 * @param array           $claim   array( slug, position ).
	 * @param array           $client  Resolved client.
	 * @param Request         $request Request.
	 * @return array
	 */
	private function ip_path( $index, $claim, $client, $request ) {
		$slug     = $claim[0];
		$operator = $index->operator( $slug );
		$agent    = $operator['agents'][ $claim[1] ];
		$matcher  = $index->ip_matcher( $slug, $agent['ip_list_agent'] );
		$rule     = $operator['rdns'];
		$address  = $client['address'];
		if ( null === $address ) {
			return self::result(
				'declared_unverifiable',
				$slug,
				$agent,
				array(
					'method' => 'none',
					'reason' => 'no_client_address',
					'note'   => 'The client address is unknown.',
				)
			);
		}
		if ( null !== $matcher && $matcher->has( $address ) ) {
			return self::result(
				'verified_by_ip',
				$slug,
				$agent,
				array(
					'method' => 'ip',
					'note'   => "The address is in the operator's published IP list.",
				)
			);
		}
		if ( null !== $rule && array() !== $rule ) {
			if ( ! $this->rdns()->available() ) {
				return self::result(
					'declared_unverifiable',
					$slug,
					$agent,
					array(
						'method' => 'none',
						'reason' => 'no_dns',
						'note'   => 'Reverse DNS would decide, and this runtime has no DNS.',
					)
				);
			}
			$entry = $this->rdns()->get( $address->text );
			if ( null !== $entry && 'confirmed' === $entry['status'] ) {
				foreach ( $entry['hostnames'] as $hostname ) {
					if ( Rdns_Cache::matches_suffix( $hostname, $rule ) ) {
						return self::result(
							'verified_by_ip',
							$slug,
							$agent,
							array(
								'method' => 'rdns',
								'note'   => "Forward-confirmed reverse DNS matches the operator's documented domain.",
							)
						);
					}
				}
				return self::result(
					'claimed_failed',
					$slug,
					$agent,
					array(
						'method' => 'rdns',
						'reason' => 'rdns_mismatch',
						'note'   => "The address is outside the operator's IP lists and its reverse DNS is not the operator's domain.",
					)
				);
			}
			if ( null !== $entry && 'unconfirmed' === $entry['status'] ) {
				return self::result(
					'claimed_failed',
					$slug,
					$agent,
					array(
						'method' => 'rdns',
						'reason' => 'rdns_unconfirmed',
						'note'   => "The address is outside the operator's IP lists and has no forward-confirmed reverse DNS.",
					)
				);
			}
			if ( null !== $entry && 'error' === $entry['status'] ) {
				return $this->fail_open( $request, 'reverse DNS lookup failed: ' . $entry['message'], 'rdns_error' );
			}
			$this->rdns()->schedule( $address->text );
			return self::result(
				'declared_unverifiable',
				$slug,
				$agent,
				array(
					'method' => 'none',
					'reason' => 'rdns_pending',
					'note'   => 'A reverse DNS lookup for this address is queued; later requests get its result.',
				)
			);
		}
		if ( null !== $matcher ) {
			return self::result(
				'claimed_failed',
				$slug,
				$agent,
				array(
					'method' => 'ip',
					'reason' => 'outside_ip_list',
					'note'   => "The address is outside the operator's published IP lists.",
				)
			);
		}
		$signs = $index->key_count( $slug ) > 0;
		// A community token on a request that otherwise looks like a browser: the
		// token may be an ordinary word (docs/notes/real-traffic-checks.md, item 13).
		if ( $signs ) {
			$reason = 'unsigned';
		} elseif ( 'community' === $agent['coverage'] && null === Automation::signal( $request ) ) {
			$reason = 'community_token_on_browser';
		} else {
			$reason = 'nothing_published';
		}
		return self::result(
			'declared_unverifiable',
			$slug,
			$agent,
			array(
				'method' => 'none',
				'reason' => $reason,
				'note'   => $signs ? 'The operator signs requests, and this one is not signed.' : 'The operator publishes no keys, IP lists or reverse DNS rules.',
			)
		);
	}

	/**
	 * Labels one request.
	 *
	 * @param Request $request Request.
	 * @return array
	 */
	private function label( $request ) {
		$index = $this->store->index();
		if ( null === $index ) {
			$why = null === $this->store->last_error ? 'unknown reason' : $this->store->last_error;
			return $this->fail_open( $request, 'directory not loaded (' . $why . ')', 'directory_unavailable' );
		}
		$now_ms = call_user_func( $this->now );
		if ( ! is_numeric( $now_ms ) || ! is_finite( (float) $now_ms ) || $now_ms <= 0 ) {
			return $this->fail_open( $request, 'the system clock returned an invalid time', 'clock_invalid' );
		}

		$client = $this->resolver->resolve( $request );
		$this->guard->record( $client['address'] );
		$claim   = Claim::identify( $request, $index );
		$claimed = array() === $claim['signature_operators'] ? null : $claim['signature_operators'][0];

		if ( null !== $claimed && $claim['signed'] ) {
			$outcome = Signature_Path::verify_signatures(
				array(
					'index'        => $index,
					'request'      => array(
						'method'     => $request->method,
						'target_uri' => $client['scheme'] . '://' . ( null === $client['host'] ? 'invalid.invalid' : $client['host'] ) . $request->target,
						'fields'     => $request->fields,
					),
					'now'          => (int) floor( $now_ms / 1000 ),
					'clock_skew'   => $this->clock_skew,
					'max_validity' => $this->max_validity,
					'nonces'       => $this->nonces(),
					'library'      => null === $this->library ? new Default_Signature_Library() : $this->library,
					'claimed'      => $claimed,
					'operators'    => $claim['signature_operators'],
				)
			);
			switch ( $outcome['kind'] ) {
				case 'verified':
					return self::result(
						'verified_by_signature',
						$outcome['operator'],
						self::signing_agent( $index, $outcome['operator'], $claim['user_agent'] ),
						array(
							'method' => 'signature',
							'note'   => "A Web Bot Auth signature verified against the operator's published key.",
						)
					);
				case 'invalid':
					return self::result(
						'claimed_failed',
						$outcome['operator'],
						self::signing_agent( $index, $outcome['operator'], $claim['user_agent'] ),
						array(
							'method' => 'signature',
							'reason' => $outcome['code'],
							'note'   => 'The signature did not verify: ' . $outcome['reason'] . '.',
						)
					);
				case 'unknown_key':
					$this->store->request_keys_refresh();
					return self::result(
						'declared_unverifiable',
						$outcome['operator'],
						self::signing_agent( $index, $outcome['operator'], $claim['user_agent'] ),
						array(
							'method' => 'signature',
							'reason' => 'unknown_kid',
							'note'   => 'The signing key is not one this install holds yet; a keys refresh was requested.',
						)
					);
				case 'error':
					return $this->fail_open( $request, $outcome['error'], $outcome['code'] );
			}
		}

		// A User-Agent claim is checked even when Signature-Agent named nothing
		// usable, so an invented Signature-Agent cannot soften a failed check.
		if ( null !== $claim['user_agent'] ) {
			return $this->ip_path( $index, $claim['user_agent'], $client, $request );
		}
		if ( null !== $claimed ) {
			return array(
				'verdict'  => 'declared_unverifiable',
				'operator' => $claimed,
				'method'   => 'none',
				'reason'   => $claim['signed'] ? 'no_keys' : 'unsigned',
				'note'     => $claim['signed']
					? 'This install holds no keys for the operator the Signature-Agent names.'
					: 'Signature-Agent names a listed operator, and the request is not signed.',
			);
		}
		if ( $claim['signature_agent_present'] ) {
			return array(
				'verdict' => 'declared_unverifiable',
				'method'  => 'none',
				'reason'  => 'unlisted_signature_agent',
				'note'    => 'Signature-Agent names a key directory that is not in the operator directory; nothing was fetched.',
			);
		}
		$signal = Automation::signal( $request );
		if ( null !== $signal ) {
			return array(
				'verdict' => 'unknown_automation',
				'method'  => 'none',
				'reason'  => $signal,
				'note'    => 'Automated, and claims no agent in the directory.',
			);
		}
		return array(
			'verdict' => 'human',
			'method'  => 'none',
		);
	}
}
