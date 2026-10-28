<?php
/**
 * The signature path of the verifier (docs/SPEC.md section 4.4).
 *
 * A port of packages/core/src/verifier/signature-path.ts: every Web Bot Auth
 * label is checked on its own, keys come only from the loaded keys.json,
 * nothing is ever fetched, and anything the port cannot evaluate fails open.
 *
 * @package Posterna
 */

namespace Posterna\Signature;

use Posterna\Verifier\Directory_Index;
use Posterna\Verifier\Url;

defined( 'ABSPATH' ) || exit;

/**
 * Verifies the Web Bot Auth signatures on a request.
 */
final class Signature_Path {

	const ALGORITHMS = array( 'ed25519', 'rsa-pss-sha512' );

	/**
	 * Verifies the signatures on a request whose Signature-Agent names a listed operator.
	 *
	 * @param array $context array( 'index' => Directory_Index, 'request' => request descriptor,
	 *                       'now' => seconds, 'clock_skew', 'max_validity', 'nonces' => Nonce_Store,
	 *                       'library' => Signature_Library, 'claimed' => slug, 'operators' => slugs ).
	 * @return array Outcome: array( 'kind' => verified|invalid|unknown_key|no_keys|unsigned|error,
	 *               'operator', 'reason', 'code', 'error' ).
	 */
	public static function verify_signatures( $context ) {
		$input = Web_Bot_Auth::header( $context['request'], 'signature-input' );
		if ( null === $input || null === Web_Bot_Auth::header( $context['request'], 'signature' ) ) {
			return array( 'kind' => 'unsigned' );
		}
		try {
			$labels = self::web_bot_auth_labels( $input );
		} catch ( Sf_Error $error ) {
			return array(
				'kind'     => 'invalid',
				'operator' => $context['claimed'],
				'reason'   => 'Signature-Input could not be parsed',
				'code'     => 'malformed_signature',
			);
		}
		if ( array() === $labels ) {
			return array( 'kind' => 'unsigned' );
		}
		$held = false;
		foreach ( $context['operators'] as $slug ) {
			$keys = $context['index']->keys( $slug );
			if ( null !== $keys && array() !== $keys['keys'] ) {
				$held = true;
			}
		}
		if ( ! $held ) {
			return array(
				'kind'     => 'no_keys',
				'operator' => $context['claimed'],
			);
		}
		$outcomes = array();
		foreach ( $labels as $label => $has_alg ) {
			$outcome = self::verify_label( $context, (string) $label, $has_alg );
			if ( 'verified' === $outcome['kind'] ) {
				return $outcome;
			}
			$outcomes[] = $outcome;
		}
		foreach ( array( 'invalid', 'unknown_key', 'no_keys', 'error' ) as $kind ) {
			foreach ( $outcomes as $outcome ) {
				if ( $kind === $outcome['kind'] ) {
					return $outcome;
				}
			}
		}
		return array( 'kind' => 'unsigned' );
	}

	/**
	 * Web Bot Auth labels in Signature-Input, with whether each carries alg.
	 *
	 * @param string $input Signature-Input value.
	 * @return array label => bool.
	 * @throws Sf_Error When the header cannot be parsed.
	 */
	private static function web_bot_auth_labels( $input ) {
		$labels = array();
		foreach ( Structured_Fields::parse_dictionary( $input ) as $label => $member ) {
			if ( ! Structured_Fields::is_inner_list( $member ) ) {
				continue;
			}
			$parameters = $member[1];
			if ( isset( $parameters['tag'] ) && Web_Bot_Auth::TAG === $parameters['tag'] ) {
				$labels[ $label ] = array_key_exists( 'alg', $parameters );
			}
		}
		return $labels;
	}

	/**
	 * Unwraps resolver failures to the error behind them.
	 *
	 * @param \Throwable $error Error.
	 * @return \Throwable
	 */
	private static function unwrap( $error ) {
		$current = $error;
		for ( $depth = 0; $depth < 5; $depth++ ) {
			if ( $current instanceof Signature_Error && Signature_Error::RESOLVER_FAILED === $current->sig_code && null !== $current->getPrevious() ) {
				$current = $current->getPrevious();
			} else {
				break;
			}
		}
		return $current;
	}

	/**
	 * Profile checks for a signature without alg, which the protocol draft
	 * allows and web-bot-auth 0.2.0 does not.
	 *
	 * @param array $request   Request descriptor.
	 * @param array $candidate Unverified signature.
	 * @return array array( 'keyid', 'agent' ).
	 * @throws Signature_Error When the profile is not met.
	 */
	private static function profile_without_alg( $request, $candidate ) {
		$parameters = $candidate['parameters'];
		$keyid      = isset( $parameters['keyid'] ) ? $parameters['keyid'] : null;
		if ( ! is_string( $keyid ) || '' === $keyid ) {
			$exception = new Signature_Error( Signature_Error::POLICY_VIOLATION, 'keyid must be a non-empty string' );
			throw $exception;
		}
		if ( ! isset( $parameters['tag'] ) || Web_Bot_Auth::TAG !== $parameters['tag'] ) {
			$exception = new Signature_Error( Signature_Error::POLICY_VIOLATION, "tag must be 'web-bot-auth'" );
			throw $exception;
		}
		$created = isset( $parameters['created'] ) ? $parameters['created'] : null;
		$expires = isset( $parameters['expires'] ) ? $parameters['expires'] : null;
		if ( ( ! is_int( $created ) && ! is_float( $created ) ) || ( ! is_int( $expires ) && ! is_float( $expires ) ) ) {
			$exception = new Signature_Error( Signature_Error::POLICY_VIOLATION, 'created and expires must be integers' );
			throw $exception;
		}
		if ( $created > $expires ) {
			$exception = new Signature_Error( Signature_Error::POLICY_VIOLATION, 'created must not be after expires' );
			throw $exception;
		}
		if ( ! Web_Bot_Auth::has_bare_target( $candidate['components'] ) ) {
			$exception = new Signature_Error( Signature_Error::POLICY_VIOLATION, 'signature must cover bare @authority or bare @target-uri' );
			throw $exception;
		}
		return array(
			'keyid' => $keyid,
			'agent' => Web_Bot_Auth::covered_signature_agent( $request, $candidate['components'] ),
		);
	}

	/**
	 * Checks one Ed25519 key. RSA-PSS keys are not supported by this port.
	 *
	 * @param array  $key       Key from the index.
	 * @param string $data      Signature base.
	 * @param string $signature Signature bytes.
	 * @return bool
	 * @throws Signature_Error For a key type this port cannot verify.
	 */
	public static function key_verifies( $key, $data, $signature ) {
		if ( 'ed25519' !== $key['algorithm'] ) {
			$exception = new Signature_Error( Signature_Error::UNSUPPORTED_FEATURE, 'rsa-pss-sha512 keys are not supported by the PHP port' );
			throw $exception;
		}
		$public = Structured_Fields::decode_base64( strtr( $key['x'], '-_', '+/' ) . str_repeat( '=', ( 4 - strlen( $key['x'] ) % 4 ) % 4 ) );
		if ( null === $public || 32 !== strlen( $public ) || 64 !== strlen( $signature ) ) {
			return false;
		}
		return sodium_crypto_sign_verify_detached( $signature, $data, $public );
	}

	/**
	 * Verifies one label.
	 *
	 * @param array  $context Signature context.
	 * @param string $label   Signature label.
	 * @param bool   $has_alg Whether the signature carries alg.
	 * @return array Outcome.
	 */
	private static function verify_label( $context, $label, $has_alg ) {
		$index          = $context['index'];
		$request        = $context['request'];
		$nonces         = $context['nonces'];
		$max_validity   = $context['max_validity'];
		$operator       = null;
		$rejection      = null;
		$rejection_code = null;
		$verified_keyid = '';

		$resolve = function ( $keyid, $agent ) use ( $index, &$operator, &$verified_keyid ) {
			if ( null === $agent || 'directory' !== $agent['type'] ) {
				$exception = new Key_Resolution_Error( Key_Resolution_Error::FOREIGN_AGENT, 'no directory Signature-Agent member' );
				throw $exception;
			}
			$origin = Url::signature_agent_origin( $agent['uri'] );
			$named  = null === $origin ? null : $index->signing_origin( $origin );
			if ( null === $named ) {
				$exception = new Key_Resolution_Error( Key_Resolution_Error::FOREIGN_AGENT, 'the Signature-Agent member names no listed operator' );
				throw $exception;
			}
			$operator = $named;
			$held     = $index->keys( $named );
			if ( null === $held || array() === $held['keys'] ) {
				$exception = new Key_Resolution_Error( Key_Resolution_Error::NO_KEYS, 'no keys held for this operator' );
				throw $exception;
			}
			// Match by kid, then by RFC 7638 thumbprint, then every key when the operator uses no kid.
			$candidates = array();
			foreach ( $held['keys'] as $key ) {
				if ( $key['kid'] === $keyid ) {
					$candidates[] = $key;
				}
			}
			if ( array() === $candidates ) {
				foreach ( $held['keys'] as $key ) {
					if ( $key['thumbprint'] === $keyid ) {
						$candidates[] = $key;
					}
				}
			}
			if ( array() === $candidates ) {
				if ( $held['uses_kid'] ) {
					$exception = new Key_Resolution_Error( Key_Resolution_Error::UNKNOWN_KEY, 'unknown kid' );
					throw $exception;
				}
				$candidates = $held['keys'];
			}
			$algorithm = $candidates[0]['algorithm'];
			$usable    = array();
			foreach ( $candidates as $key ) {
				if ( $key['algorithm'] === $algorithm ) {
					$usable[] = $key;
				}
			}
			$verified_keyid = $keyid;
			return array(
				'algorithm' => $algorithm,
				'keyid'     => $keyid,
				'verify'    => function ( $data, $signature ) use ( $usable ) {
					foreach ( $usable as $key ) {
						if ( self::key_verifies( $key, $data, $signature ) ) {
							return true;
						}
					}
					return false;
				},
			);
		};

		$validate = function ( $created, $expires, $keyid, $nonce ) use ( $max_validity, $nonces, &$operator, &$rejection, &$rejection_code ) {
			if ( $expires - $created > $max_validity ) {
				$rejection      = 'validity window of ' . ( $expires - $created ) . ' seconds is longer than ' . $max_validity;
				$rejection_code = 'validity_too_long';
				return false;
			}
			if ( null !== $nonce ) {
				$key = ( null === $operator ? '' : $operator ) . "\0" . $keyid . "\0" . $nonce;
				if ( $nonces->has( $key ) ) {
					$rejection      = 'nonce already used (replay)';
					$rejection_code = 'nonce_replayed';
					return false;
				}
				$nonces->add( $key );
			}
			return true;
		};

		try {
			if ( $has_alg ) {
				$context['library']->web_bot_auth_verify(
					$request,
					array(
						'label'      => $label,
						'algorithms' => self::ALGORITHMS,
						'max_age'    => $max_validity,
						'clock_skew' => $context['clock_skew'],
						'now'        => $context['now'],
						'resolver'   => function ( $profile ) use ( $resolve ) {
							return $resolve( $profile['keyid'], $profile['signature_agent'] );
						},
						'validate'   => function ( $signature ) use ( $validate ) {
							return $validate( $signature['created'], $signature['expires'], $signature['keyid'], $signature['nonce'] );
						},
					)
				);
			} else {
				$context['library']->verify_signature(
					$request,
					array(
						'label'            => $label,
						'policy'           => array(
							'algorithms'          => self::ALGORITHMS,
							'required_components' => array(),
							'required_parameters' => array( 'created', 'expires', 'keyid', 'tag' ),
							'max_age'             => $max_validity,
							'clock_skew'          => $context['clock_skew'],
							'now'                 => $context['now'],
							'validate'            => function ( $signature ) use ( $validate ) {
								$parameters = $signature['parameters'];
								return $validate( $parameters['created'], $parameters['expires'], $parameters['keyid'], isset( $parameters['nonce'] ) ? $parameters['nonce'] : null );
							},
						),
						'resolve_verifier' => function ( $candidate ) use ( $request, $resolve ) {
							$profile = self::profile_without_alg( $request, $candidate );
							return $resolve( $profile['keyid'], $profile['agent'] );
						},
					)
				);
			}
			return array(
				'kind'     => 'verified',
				'operator' => null === $operator ? $context['claimed'] : $operator,
				'keyid'    => $verified_keyid,
			);
		} catch ( \Throwable $thrown ) {
			$error   = self::unwrap( $thrown );
			$subject = null === $operator ? $context['claimed'] : $operator;
			if ( $error instanceof Key_Resolution_Error ) {
				if ( Key_Resolution_Error::FOREIGN_AGENT === $error->kind ) {
					return array( 'kind' => 'unsigned' );
				}
				return array(
					'kind'     => $error->kind,
					'operator' => $subject,
				);
			}
			if ( $error instanceof Signature_Error ) {
				if ( Signature_Error::UNSUPPORTED_FEATURE === $error->sig_code || Signature_Error::RESOLVER_FAILED === $error->sig_code ) {
					return array(
						'kind'     => 'error',
						'operator' => $subject,
						'error'    => 'signature library: ' . $error->getMessage(),
						'code'     => 'library_unsupported',
					);
				}
				return array(
					'kind'     => 'invalid',
					'operator' => $subject,
					'reason'   => null === $rejection ? $error->getMessage() : $rejection,
					'code'     => null === $rejection_code ? self::rejection_reason( $error->sig_code, $error->getMessage() ) : $rejection_code,
				);
			}
			return array(
				'kind'     => 'error',
				'operator' => $subject,
				'error'    => 'signature library: ' . $error->getMessage(),
				'code'     => 'library_error',
			);
		}
	}

	/**
	 * A stable reason code for a signature the library rejected.
	 *
	 * @param string $code    Signature_Error code.
	 * @param string $message Error message.
	 * @return string Reason code.
	 */
	public static function rejection_reason( $code, $message ) {
		if ( Signature_Error::VERIFICATION_FAILED === $code ) {
			return 'signature_invalid';
		}
		if ( Signature_Error::POLICY_VIOLATION === $code ) {
			if ( preg_match( '/expired|too old/i', $message ) ) {
				return 'expired';
			}
			if ( preg_match( '/in the future/i', $message ) ) {
				return 'created_in_future';
			}
			if ( preg_match( '/nonce/i', $message ) ) {
				return 'nonce_rejected';
			}
			return 'profile_rejected';
		}
		if ( Signature_Error::ALGORITHM_MISMATCH === $code ) {
			return 'profile_rejected';
		}
		return 'malformed_signature';
	}
}
