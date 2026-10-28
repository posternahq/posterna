<?php
/**
 * Compiles directory.json and keys.json into the lookups the verifier needs.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * A port of packages/core/src/directory/index-builder.ts. Compiling runs when
 * the plugin is activated or updated and after a refresh, never per request.
 * The result is plain arrays, so the plugin can keep it in options.
 */
final class Index_Builder {

	/**
	 * The RFC 9421 example key. The protocol draft says verifiers SHOULD reject
	 * known test keys found in key directories.
	 */
	const KNOWN_TEST_KEYS = array( 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' );

	const TOKEN_PATTERN = '/^[A-Za-z0-9][A-Za-z0-9._-]*$/';

	/**
	 * Checks the parts of directory.json the verifier relies on.
	 *
	 * @param mixed $value Decoded JSON.
	 * @throws \UnexpectedValueException When it is malformed.
	 */
	public static function check_directory_shape( $value ) {
		if ( ! is_array( $value ) || ! isset( $value['operators'] ) || ! is_array( $value['operators'] ) || ! self::is_list( $value['operators'] ) ) {
			$exception = new \UnexpectedValueException( 'directory.json has no operators array' );
			throw $exception;
		}
		foreach ( $value['operators'] as $op ) {
			if ( ! is_array( $op ) || ! isset( $op['slug'] ) || ! is_string( $op['slug'] ) || ! isset( $op['agents'] ) || ! is_array( $op['agents'] )
				|| ! isset( $op['verification'] ) || ! is_array( $op['verification'] ) || ! isset( $op['verification']['ip_lists'] )
				|| ! is_array( $op['verification']['ip_lists'] ) || empty( $op['verification']['signing'] ) ) {
				$exception = new \UnexpectedValueException( 'directory.json has a malformed operator record' );
				throw $exception;
			}
			foreach ( $op['agents'] as $agent ) {
				if ( ! is_array( $agent ) || ! isset( $agent['name'] ) || ! is_string( $agent['name'] ) || ! isset( $agent['user_agent_tokens'] ) || ! is_array( $agent['user_agent_tokens'] ) ) {
					$exception = new \UnexpectedValueException( 'directory.json has a malformed agent in ' . $op['slug'] );
					throw $exception;
				}
			}
		}
	}

	/**
	 * True for an array with keys 0..n-1 in order (array_is_list() is PHP 8.1).
	 *
	 * @param array $value Array.
	 * @return bool
	 */
	private static function is_list( $value ) {
		return array() === $value || array_keys( $value ) === range( 0, count( $value ) - 1 );
	}

	/**
	 * Checks the parts of keys.json the verifier relies on.
	 *
	 * @param mixed $value Decoded JSON.
	 * @throws \UnexpectedValueException When it is malformed.
	 */
	public static function check_keys_shape( $value ) {
		if ( ! is_array( $value ) || ! isset( $value['operators'] ) || ! is_array( $value['operators'] ) ) {
			$exception = new \UnexpectedValueException( 'keys.json has no operators object' );
			throw $exception;
		}
		foreach ( $value['operators'] as $slug => $op ) {
			if ( ! is_array( $op ) || ! isset( $op['keys'] ) || ! is_array( $op['keys'] ) ) {
				$exception = new \UnexpectedValueException( 'keys.json has malformed keys for ' . $slug );
				throw $exception;
			}
		}
	}

	/**
	 * Compiles directory.json.
	 *
	 * @param array $directory Decoded directory.json.
	 * @return array array( 'directory' => compiled lookups, 'ranges' => slug => packed IP lists ).
	 * @throws \UnexpectedValueException When it is malformed.
	 */
	public static function compile_directory( $directory ) {
		self::check_directory_shape( $directory );
		$compiled = array(
			'version'   => isset( $directory['version'] ) && is_string( $directory['version'] ) ? $directory['version'] : null,
			'tokens'    => array(),
			'phrases'   => array(),
			'origins'   => array(),
			'operators' => array(),
		);
		$ranges   = array();
		foreach ( $directory['operators'] as $op ) {
			$slug    = $op['slug'];
			$signing = is_array( $op['verification']['signing'] ) ? $op['verification']['signing'] : array();
			$url     = isset( $signing['directory_url'] ) && is_string( $signing['directory_url'] ) ? $signing['directory_url'] : '';
			$origin  = '' === $url ? null : Url::https_origin( $url );
			if ( null !== $origin && ! isset( $compiled['origins'][ $origin ] ) ) {
				$compiled['origins'][ $origin ] = $slug;
			}
			$rdns   = isset( $op['verification']['reverse_dns'] ) && is_array( $op['verification']['reverse_dns'] ) ? $op['verification']['reverse_dns'] : null;
			$agents = array();
			foreach ( array_values( $op['agents'] ) as $position => $agent ) {
				$agents[] = array(
					'name'          => $agent['name'],
					'purpose'       => isset( $agent['purpose'] ) && is_string( $agent['purpose'] ) ? $agent['purpose'] : null,
					'coverage'      => isset( $agent['coverage'] ) && is_string( $agent['coverage'] ) ? $agent['coverage'] : null,
					'signs'         => ! empty( $agent['signs'] ),
					'ip_list_agent' => isset( $agent['ip_list_agent'] ) && is_string( $agent['ip_list_agent'] ) && '' !== $agent['ip_list_agent'] ? $agent['ip_list_agent'] : null,
					'search_engine' => ! empty( $agent['search_engine'] ),
					'robots_token'  => isset( $agent['robots_token'] ) && is_string( $agent['robots_token'] ) && '' !== $agent['robots_token'] ? $agent['robots_token'] : null,
					'robots_policy' => isset( $agent['robots_policy'] ) && is_string( $agent['robots_policy'] ) ? $agent['robots_policy'] : null,
				);
				$ref      = array( $slug, $position );
				foreach ( $agent['user_agent_tokens'] as $token ) {
					if ( is_string( $token ) ) {
						self::add_token( $compiled, $token, $ref, $agents[ $position ]['coverage'] );
					}
				}
				foreach ( isset( $agent['aliases'] ) && is_array( $agent['aliases'] ) ? $agent['aliases'] : array() as $alias ) {
					if ( is_string( $alias ) && preg_match( self::TOKEN_PATTERN, preg_replace( '/\/[A-Za-z0-9_.-]*$/', '', $alias ) ) ) {
						self::add_token( $compiled, $alias, $ref, $agents[ $position ]['coverage'] );
					}
				}
			}
			$lists = array();
			$all   = array();
			foreach ( $op['verification']['ip_lists'] as $list ) {
				$prefixes = isset( $list['prefixes'] ) && is_array( $list['prefixes'] ) ? $list['prefixes'] : array();
				$name     = isset( $list['agent'] ) ? (string) $list['agent'] : '';

				$lists[ $name ] = Prefix_Matcher::compile( $prefixes )->to_packed();
				$all            = array_merge( $all, $prefixes );
			}
			if ( array() !== $op['verification']['ip_lists'] ) {
				$ranges[ $slug ] = array(
					'lists' => $lists,
					'all'   => count( $op['verification']['ip_lists'] ) > 1 ? Prefix_Matcher::compile( $all )->to_packed() : null,
				);
			}
			$compiled['operators'][ $slug ] = array(
				'name'      => isset( $op['name'] ) && is_string( $op['name'] ) ? $op['name'] : $slug,
				'rdns'      => ( null !== $rdns && isset( $rdns['suffixes'] ) && is_array( $rdns['suffixes'] ) ) ? array_values( array_filter( $rdns['suffixes'], 'is_string' ) ) : null,
				'has_lists' => array() !== $op['verification']['ip_lists'],
				'covers'    => isset( $signing['covers'] ) && is_array( $signing['covers'] ) ? array_values( array_filter( $signing['covers'], 'is_string' ) ) : array(),
				'agents'    => $agents,
			);
		}
		// Longest pattern first, measured as JavaScript writes the escaped pattern.
		usort(
			$compiled['phrases'],
			function ( $a, $b ) {
				return $b[3] - $a[3];
			}
		);
		return array(
			'directory' => $compiled,
			'ranges'    => $ranges,
		);
	}

	/**
	 * Adds one user-agent token: single words go in the token map, anything
	 * else becomes a whole-phrase pattern.
	 *
	 * @param array  $compiled Compiled directory, by reference.
	 * @param string $raw      Token as listed, possibly with a /version.
	 * @param array  $ref      array( slug, agent position ).
	 * @param mixed  $coverage The agent's coverage.
	 */
	private static function add_token( &$compiled, $raw, $ref, $coverage ) {
		$token = trim( preg_replace( '/\/[A-Za-z0-9_.-]*$/', '', $raw ) );
		if ( '' === $token ) {
			return;
		}
		if ( preg_match( self::TOKEN_PATTERN, $token ) ) {
			$key = strtolower( $token );
			// A researched agent wins over a community one with the same token.
			if ( ! isset( $compiled['tokens'][ $key ] ) || ( 'community' === $compiled['tokens'][ $key ][2] && 'researched' === $coverage ) ) {
				$compiled['tokens'][ $key ] = array( $ref[0], $ref[1], $coverage );
			}
			return;
		}
		$js_length             = strlen( $token ) + preg_match_all( '/[.*+?^${}()|[\]\\\\]/', $token );
		$compiled['phrases'][] = array(
			'/(^|[^A-Za-z0-9])' . preg_quote( $token, '/' ) . '($|[^A-Za-z0-9])/i',
			$ref[0],
			$ref[1],
			$js_length,
		);
	}

	/**
	 * The RFC 7638 thumbprint of a public JWK, base64url.
	 *
	 * @param array $jwk JWK.
	 * @return string
	 * @throws \UnexpectedValueException For an unsupported key type.
	 */
	public static function thumbprint( $jwk ) {
		$kty = isset( $jwk['kty'] ) ? $jwk['kty'] : null;
		$get = function ( $name ) use ( $jwk ) {
			return isset( $jwk[ $name ] ) && is_scalar( $jwk[ $name ] ) ? (string) $jwk[ $name ] : 'undefined';
		};
		if ( 'OKP' === $kty ) {
			$text = '{"crv":"' . $get( 'crv' ) . '","kty":"OKP","x":"' . $get( 'x' ) . '"}';
		} elseif ( 'RSA' === $kty ) {
			$text = '{"e":"' . $get( 'e' ) . '","kty":"RSA","n":"' . $get( 'n' ) . '"}';
		} elseif ( 'EC' === $kty ) {
			$text = '{"crv":"' . $get( 'crv' ) . '","kty":"EC","x":"' . $get( 'x' ) . '","y":"' . $get( 'y' ) . '"}';
		} else {
			$exception = new \UnexpectedValueException( 'Unsupported key type' );
			throw $exception;
		}
		return rtrim( strtr( base64_encode( hash( 'sha256', $text, true ) ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- RFC 7638 thumbprint encoding.
	}

	/**
	 * Decodes strict unpadded base64url, or returns null.
	 *
	 * @param mixed $value Text.
	 * @return string|null
	 */
	public static function base64url_decode( $value ) {
		if ( ! is_string( $value ) || ! preg_match( '/^[A-Za-z0-9_-]*$/', $value ) || 1 === strlen( $value ) % 4 ) {
			return null;
		}
		// Plain decoding of base64url that was checked above; this is not obfuscation.
		$decoded = base64_decode( strtr( $value, '-_', '+/' ) . str_repeat( '=', ( 4 - strlen( $value ) % 4 ) % 4 ), true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		return false === $decoded ? null : $decoded;
	}

	/**
	 * Compiles keys.json. Keys for operators the directory does not list are
	 * kept but never used (Directory_Index::keys() checks the directory).
	 *
	 * @param array $keys Decoded keys.json.
	 * @return array array( 'version', 'operators' => slug => array( 'uses_kid', 'keys' ), 'skipped' ).
	 * @throws \UnexpectedValueException When it is malformed.
	 */
	public static function compile_keys( $keys ) {
		self::check_keys_shape( $keys );
		$compiled = array(
			'version'   => isset( $keys['version'] ) && is_string( $keys['version'] ) ? $keys['version'] : null,
			'operators' => array(),
			'skipped'   => array(),
		);
		foreach ( $keys['operators'] as $slug => $op ) {
			$imported = array();
			foreach ( $op['keys'] as $entry ) {
				$jwk = isset( $entry['jwk'] ) && is_array( $entry['jwk'] ) ? $entry['jwk'] : array();
				if ( isset( $jwk['x'] ) && is_string( $jwk['x'] ) && in_array( $jwk['x'], self::KNOWN_TEST_KEYS, true ) ) {
					$compiled['skipped'][] = $slug . ': a published test key was ignored';
					continue;
				}
				try {
					$imported[] = self::import_key( $jwk, isset( $entry['kid'] ) && is_string( $entry['kid'] ) ? $entry['kid'] : null );
				} catch ( \UnexpectedValueException $error ) {
					$compiled['skipped'][] = $slug . ': ' . $error->getMessage();
				}
			}
			$uses_kid = false;
			foreach ( $imported as $key ) {
				if ( null !== $key['kid'] ) {
					$uses_kid = true;
				}
			}
			$compiled['operators'][ $slug ] = array(
				'uses_kid' => $uses_kid,
				'keys'     => $imported,
			);
		}
		return $compiled;
	}

	/**
	 * Checks one public JWK as web-bot-auth's verifierFromJWK does.
	 *
	 * @param array       $jwk JWK.
	 * @param string|null $kid kid from keys.json.
	 * @return array array( 'kid', 'thumbprint', 'algorithm', 'x' ).
	 * @throws \UnexpectedValueException When the key cannot be used.
	 */
	private static function import_key( $jwk, $kid ) {
		$kty = isset( $jwk['kty'] ) ? $jwk['kty'] : null;
		$crv = isset( $jwk['crv'] ) ? $jwk['crv'] : null;
		if ( 'OKP' === $kty && 'Ed25519' === $crv ) {
			if ( array_key_exists( 'alg', $jwk ) && 'EdDSA' !== $jwk['alg'] ) {
				$exception = new \UnexpectedValueException( 'Ed25519 JWK alg must be EdDSA when present' );
				throw $exception;
			}
			$public = self::base64url_decode( isset( $jwk['x'] ) ? $jwk['x'] : null );
			if ( null === $public || 32 !== strlen( $public ) ) {
				$exception = new \UnexpectedValueException( 'Invalid Ed25519 public key' );
				throw $exception;
			}
			return array(
				'kid'        => $kid,
				'thumbprint' => self::thumbprint( $jwk ),
				'algorithm'  => 'ed25519',
				'x'          => $jwk['x'],
			);
		}
		if ( 'RSA' === $kty && isset( $jwk['alg'] ) && 'PS512' === $jwk['alg'] ) {
			if ( null === self::base64url_decode( isset( $jwk['n'] ) ? $jwk['n'] : null ) || null === self::base64url_decode( isset( $jwk['e'] ) ? $jwk['e'] : null ) ) {
				$exception = new \UnexpectedValueException( 'Invalid RSA public key' );
				throw $exception;
			}
			// Kept so a signature by this key fails open (library_unsupported) instead of looking unknown.
			return array(
				'kid'        => $kid,
				'thumbprint' => self::thumbprint( $jwk ),
				'algorithm'  => 'rsa-pss-sha512',
				'x'          => '',
			);
		}
		$exception = new \UnexpectedValueException( 'JWK must be Ed25519 or RSA-PSS/SHA-512' );
		throw $exception;
	}
}
