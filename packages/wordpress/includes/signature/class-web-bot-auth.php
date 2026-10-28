<?php
/**
 * The Web Bot Auth profile of HTTP Message Signatures.
 *
 * A port of the parts of Cloudflare's web-bot-auth 0.2.0 that Posterna's
 * TypeScript core uses: Signature-Agent parsing, nonce format, and the
 * profile checks around RFC 9421 verification. Notes on the port:
 * docs/REVIEW-NOTES.md.
 *
 * @package Posterna
 */

namespace Posterna\Signature;

use Posterna\Verifier\Url;

defined( 'ABSPATH' ) || exit;

/**
 * Web Bot Auth verification (draft-meunier-web-bot-auth-architecture,
 * draft-ietf-webbotauth-httpsig-protocol).
 */
final class Web_Bot_Auth {

	const TAG        = 'web-bot-auth';
	const ALGORITHMS = array( 'ed25519', 'rsa-pss-sha512' );

	/**
	 * Throws a policy violation.
	 *
	 * @param string $message Message.
	 * @throws Signature_Error Always.
	 */
	private static function policy_error( $message ) {
		$exception = new Signature_Error( Signature_Error::POLICY_VIOLATION, $message );
		throw $exception;
	}

	/**
	 * Parses a Signature-Agent header: the dictionary form, else the legacy
	 * single string.
	 *
	 * @param string $header Header value.
	 * @return array array( 'kind' => 'current'|'legacy', 'entries' => list of
	 *               array( 'label', 'uri', 'type' ) ).
	 * @throws \UnexpectedValueException When the header cannot be read.
	 */
	public static function parse_signature_agent( $header ) {
		try {
			$dictionary = Structured_Fields::parse_dictionary( $header );
			if ( array() === $dictionary ) {
				$exception = new \UnexpectedValueException( 'Signature-Agent header must not be empty' );
				throw $exception;
			}
			$entries = array();
			foreach ( $dictionary as $label => $member ) {
				$uri = $member[0];
				if ( ! is_string( $uri ) ) {
					$exception = new \UnexpectedValueException( 'Signature-Agent values must be strings' );
					throw $exception;
				}
				$type = self::discovery_type( is_array( $member[1] ) && array_key_exists( 'type', $member[1] ) ? $member[1]['type'] : null );
				self::validate_discovery_uri( $uri, $type );
				$entries[] = array(
					'label' => (string) $label,
					'uri'   => $uri,
					'type'  => $type,
				);
			}
			return array(
				'kind'    => 'current',
				'entries' => $entries,
			);
		} catch ( \Exception $dictionary_error ) {
			try {
				$item = Structured_Fields::parse_item( $header );
				if ( ! is_string( $item[0] ) ) {
					$exception = new \UnexpectedValueException( 'legacy Signature-Agent must be a string' );
					throw $exception;
				}
				self::validate_discovery_uri( $item[0], 'directory' );
				return array(
					'kind'    => 'legacy',
					'entries' => array(
						array(
							'label' => '',
							'uri'   => $item[0],
							'type'  => 'directory',
						),
					),
				);
			} catch ( \Exception $item_error ) {
				$exception = new \UnexpectedValueException( 'failed to parse Signature-Agent header', 0, $item_error );
				throw $exception;
			}
		}
	}

	/**
	 * The discovery type of a Signature-Agent member.
	 *
	 * @param mixed $value The type parameter, or null.
	 * @return string
	 * @throws \UnexpectedValueException For a type the drafts do not define.
	 */
	private static function discovery_type( $value ) {
		if ( null === $value ) {
			return 'directory';
		}
		if ( $value instanceof Sf_Token ) {
			$name = $value->value;
		} elseif ( is_bool( $value ) ) {
			$name = $value ? 'true' : 'false';
		} elseif ( is_scalar( $value ) ) {
			$name = (string) $value;
		} else {
			$name = '';
		}
		if ( in_array( $name, array( 'directory', 'jwks_uri', 'cimd' ), true ) ) {
			return $name;
		}
		$exception = new \UnexpectedValueException( 'unsupported Signature-Agent type' );
		throw $exception;
	}

	/**
	 * Checks a Signature-Agent URI for its type.
	 *
	 * @param string $uri  URI.
	 * @param string $type Discovery type.
	 * @throws \UnexpectedValueException When the URI is not allowed.
	 */
	private static function validate_discovery_uri( $uri, $type ) {
		$url = Url::parse( $uri );
		if ( null === $url ) {
			$exception = new \UnexpectedValueException( 'Invalid URL' );
			throw $exception;
		}
		if ( 'directory' === $type ) {
			if ( 'http' === $url['scheme'] || 'https' === $url['scheme'] ) {
				return;
			}
			$exception = new \UnexpectedValueException( 'directory Signature-Agent must use http or https' );
			throw $exception;
		}
		if ( 'https' !== $url['scheme'] ) {
			$exception = new \UnexpectedValueException( $type . ' Signature-Agent must use https' );
			throw $exception;
		}
	}

	/**
	 * Decodes base64 or base64url, or returns null.
	 *
	 * @param string $value Text.
	 * @return string|null
	 */
	private static function decode_base64( $value ) {
		$normalized = strtr( $value, '-_', '+/' );
		$remainder  = strlen( $normalized ) % 4;
		if ( 1 === $remainder ) {
			return null;
		}
		return Structured_Fields::decode_base64( $normalized . str_repeat( '=', ( 4 - $remainder ) % 4 ) );
	}

	/**
	 * True for a nonce of 64 bytes in canonical base64 or unpadded base64url.
	 *
	 * @param mixed $nonce Nonce parameter.
	 * @return bool
	 */
	public static function valid_nonce( $nonce ) {
		if ( ! is_string( $nonce ) ) {
			return false;
		}
		$decoded = self::decode_base64( $nonce );
		if ( null === $decoded || 64 !== strlen( $decoded ) ) {
			return false;
		}
		$standard = base64_encode( $decoded ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- Checking that a nonce is canonical base64.
		return $standard === $nonce || rtrim( strtr( $standard, '+/', '-_' ), '=' ) === $nonce;
	}

	/**
	 * A request header's values, trimmed and joined.
	 *
	 * @param array  $request Request descriptor.
	 * @param string $name    Lowercase name.
	 * @return string|null
	 */
	public static function header( $request, $name ) {
		$values = array();
		foreach ( $request['fields'] as $field ) {
			if ( strtolower( $field['name'] ) === $name ) {
				$values[] = trim( $field['value'] );
			}
		}
		return array() === $values ? null : implode( ', ', $values );
	}

	/**
	 * True when a signature covers bare @authority or bare @target-uri.
	 *
	 * @param array $components Covered components.
	 * @return bool
	 */
	public static function has_bare_target( $components ) {
		foreach ( $components as $component ) {
			if ( ( '@authority' === $component['name'] || '@target-uri' === $component['name'] ) && array() === $component['parameters'] ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The Signature-Agent member a signature covers.
	 *
	 * @param array $request    Request descriptor.
	 * @param array $components Covered components.
	 * @return array|null
	 * @throws Signature_Error When the coverage does not match the header.
	 */
	public static function covered_signature_agent( $request, $components ) {
		$header = self::header( $request, 'signature-agent' );
		if ( null === $header ) {
			return null;
		}
		$parsed = self::parse_signature_agent( $header );
		if ( 'legacy' === $parsed['kind'] ) {
			$covered = false;
			foreach ( $components as $component ) {
				if ( 'signature-agent' === $component['name'] && array() === $component['parameters'] ) {
					$covered = true;
				}
			}
			if ( ! $covered ) {
				self::policy_error( 'signature must cover signature-agent' );
			}
			return $parsed['entries'][0];
		}
		$keys = array();
		foreach ( $components as $component ) {
			$parameters = $component['parameters'];
			if ( 'signature-agent' === $component['name'] && 1 === count( $parameters ) && isset( $parameters['key'] ) && is_string( $parameters['key'] ) ) {
				$keys[] = $parameters['key'];
			}
		}
		if ( 1 !== count( $keys ) ) {
			self::policy_error( 'signature must cover exactly one signature-agent member' );
		}
		foreach ( $parsed['entries'] as $entry ) {
			if ( $entry['label'] === $keys[0] ) {
				return $entry;
			}
		}
		self::policy_error( 'Signature-Agent has no member ' . $keys[0] );
	}

	/**
	 * The profile checks on a signature that carries an alg parameter.
	 *
	 * @param array $request   Request descriptor.
	 * @param array $candidate Unverified signature from Message_Signature.
	 * @return array array( 'keyid', 'algorithm', 'signature_agent' ).
	 * @throws Signature_Error When the profile is not met.
	 */
	private static function profile_candidate( $request, $candidate ) {
		$parameters = $candidate['parameters'];
		if ( ! in_array( $candidate['algorithm'], self::ALGORITHMS, true ) ) {
			self::policy_error( 'signed algorithm is missing or unsupported' );
		}
		$keyid = isset( $parameters['keyid'] ) ? $parameters['keyid'] : null;
		if ( ! is_string( $keyid ) || '' === $keyid ) {
			self::policy_error( 'keyid must be a non-empty string' );
		}
		if ( ! isset( $parameters['tag'] ) || self::TAG !== $parameters['tag'] ) {
			self::policy_error( "tag must be 'web-bot-auth'" );
		}
		$created = isset( $parameters['created'] ) ? $parameters['created'] : null;
		$expires = isset( $parameters['expires'] ) ? $parameters['expires'] : null;
		if ( ! Message_Signature::is_integer( $created ) || ! Message_Signature::is_integer( $expires ) ) {
			self::policy_error( 'created and expires must be integers' );
		}
		if ( $created > $expires ) {
			self::policy_error( 'created must not be after expires' );
		}
		if ( array_key_exists( 'nonce', $parameters ) && ! self::valid_nonce( $parameters['nonce'] ) ) {
			self::policy_error( 'nonce must be canonical base64 or unpadded base64url encoding of 64 bytes' );
		}
		if ( ! self::has_bare_target( $candidate['components'] ) ) {
			self::policy_error( 'signature must cover bare @authority or bare @target-uri' );
		}
		return array(
			'keyid'           => $keyid,
			'algorithm'       => $candidate['algorithm'],
			'signature_agent' => self::covered_signature_agent( $request, $candidate['components'] ),
		);
	}

	/**
	 * Verifies a Web Bot Auth signature that carries an alg parameter.
	 *
	 * @param array $request Request descriptor.
	 * @param array $options array( 'label', 'algorithms', 'max_age', 'clock_skew', 'now' (seconds),
	 *                       'resolver' => callable( array $profile ): array, 'validate' => callable|null ).
	 * @return array The verified signature with keyid, created, expires, nonce and signature_agent.
	 * @throws Signature_Error When the signature does not verify.
	 */
	public static function verify( $request, $options ) {
		$selected = null;
		$verified = Message_Signature::verify(
			$request,
			array(
				'label'            => isset( $options['label'] ) ? $options['label'] : null,
				'policy'           => array(
					'algorithms'          => isset( $options['algorithms'] ) ? $options['algorithms'] : self::ALGORITHMS,
					'required_components' => array(),
					'required_parameters' => array( 'created', 'expires', 'keyid', 'alg', 'tag' ),
					'max_age'             => isset( $options['max_age'] ) ? $options['max_age'] : 86400,
					'clock_skew'          => isset( $options['clock_skew'] ) ? $options['clock_skew'] : 0,
					'now'                 => $options['now'],
				),
				'resolve_verifier' => function ( $candidate ) use ( $request, $options, &$selected ) {
					$profile  = self::profile_candidate( $request, $candidate );
					$selected = $profile;
					$verifier = call_user_func( $options['resolver'], $profile );
					if ( $verifier['keyid'] !== $profile['keyid'] ) {
						self::policy_error( 'resolved verifier keyid does not match signed keyid' );
					}
					return $verifier;
				},
			)
		);
		if ( null === $selected ) {
			self::policy_error( 'signature candidate was not resolved' );
		}
		$parameters = $verified['parameters'];
		if ( ! Message_Signature::is_integer( $parameters['created'] ) || ! Message_Signature::is_integer( $parameters['expires'] ) ) {
			self::policy_error( 'authenticated signature lacks timestamps' );
		}
		$result = array_merge(
			$verified,
			array(
				'keyid'           => $selected['keyid'],
				'created'         => (int) $parameters['created'],
				'expires'         => (int) $parameters['expires'],
				'tag'             => self::TAG,
				'nonce'           => isset( $parameters['nonce'] ) ? $parameters['nonce'] : null,
				'signature_agent' => $selected['signature_agent'],
			)
		);
		if ( isset( $options['validate'] ) && false === call_user_func( $options['validate'], $result ) ) {
			self::policy_error( 'signature rejected by profile validation' );
		}
		return $result;
	}
}
