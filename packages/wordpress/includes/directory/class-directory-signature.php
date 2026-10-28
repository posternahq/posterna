<?php
/**
 * Detached signatures on directory.json and keys.json (docs/SPEC.md section 3.1).
 *
 * @package Posterna
 */

namespace Posterna\Directory;

use Posterna\Verifier\Index_Builder;

defined( 'ABSPATH' ) || exit;

/**
 * Ed25519 over the exact file bytes, base64url without padding, published
 * next to the file with a .sig suffix. Verification uses libsodium (PHP's
 * sodium extension, or the sodium_compat copy WordPress ships).
 */
final class Directory_Signature {

	/**
	 * True for a trusted key this code can use.
	 *
	 * @param array $key Trusted key.
	 * @return bool
	 */
	private static function usable( $key ) {
		$jwk = isset( $key['jwk'] ) && is_array( $key['jwk'] ) ? $key['jwk'] : array();
		if ( ! isset( $jwk['kty'], $jwk['crv'], $jwk['x'] ) || 'OKP' !== $jwk['kty'] || 'Ed25519' !== $jwk['crv'] ) {
			return false;
		}
		$public = Index_Builder::base64url_decode( $jwk['x'] );
		return null !== $public && 32 === strlen( $public ) && isset( $key['generation'] ) && is_int( $key['generation'] ) && $key['generation'] > 0;
	}

	/**
	 * Checks a detached signature, trying trusted keys from the highest
	 * generation down. Accepted only under a key at or above $min_generation;
	 * one that verifies only under a lower generation is `signature_retired`.
	 * Never throws.
	 *
	 * @param string $bytes          The file exactly as downloaded.
	 * @param string $signature      Contents of the .sig file. Surrounding whitespace is ignored.
	 * @param array  $trusted_keys   Trusted keys.
	 * @param int    $min_generation Lowest generation still accepted.
	 * @return array array( 'ok' => true, 'kid', 'generation' ) or array( 'ok' => false, 'reason' ).
	 */
	public static function check( $bytes, $signature, $trusted_keys, $min_generation = 0 ) {
		try {
			$sig = Index_Builder::base64url_decode( trim( (string) $signature ) );
			if ( null === $sig || 64 !== strlen( $sig ) ) {
				return array(
					'ok'     => false,
					'reason' => 'signature_malformed',
				);
			}
			$keys = array_values( array_filter( $trusted_keys, array( self::class, 'usable' ) ) );
			usort(
				$keys,
				function ( $a, $b ) {
					return $b['generation'] - $a['generation'];
				}
			);
			foreach ( $keys as $key ) {
				if ( $key['generation'] >= $min_generation && self::verifies( $key, $sig, $bytes ) ) {
					return array(
						'ok'         => true,
						'kid'        => $key['kid'],
						'generation' => $key['generation'],
					);
				}
			}
			foreach ( $keys as $key ) {
				if ( $key['generation'] < $min_generation && self::verifies( $key, $sig, $bytes ) ) {
					return array(
						'ok'     => false,
						'reason' => 'signature_retired',
					);
				}
			}
		} catch ( \Throwable $error ) {
			return array(
				'ok'     => false,
				'reason' => 'signature_untrusted',
			);
		}
		return array(
			'ok'     => false,
			'reason' => 'signature_untrusted',
		);
	}

	/**
	 * True when the key verifies the signature.
	 *
	 * @param array  $key   Trusted key.
	 * @param string $sig   Signature bytes.
	 * @param string $bytes File bytes.
	 * @return bool
	 */
	private static function verifies( $key, $sig, $bytes ) {
		try {
			return sodium_crypto_sign_verify_detached( $sig, (string) $bytes, Index_Builder::base64url_decode( $key['jwk']['x'] ) );
		} catch ( \Throwable $error ) {
			return false;
		}
	}
}
