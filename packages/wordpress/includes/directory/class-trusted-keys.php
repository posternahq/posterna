<?php
/**
 * The Posterna directory signing keys this plugin trusts.
 *
 * @package Posterna
 */

namespace Posterna\Directory;

defined( 'ABSPATH' ) || exit;

/**
 * The same list as TRUSTED_DIRECTORY_KEYS in @posterna/core
 * (packages/core/src/directory/signature.ts); a test keeps them equal. The
 * primary's private half signs the files published at
 * https://posterna.com/v1/; the backup's private half is kept offline.
 * Rotation and the emergency runbook: docs/KEYS.md in the repository.
 */
final class Trusted_Keys {

	/**
	 * The trusted keys: kid (RFC 7638 thumbprint), role, generation, date added and public JWK.
	 *
	 * @return array
	 */
	public static function all() {
		return array(
			array(
				'kid'        => '2qUSU6hxNFv8aoHtbtW12lPokB8olcots8I1Re8Ow04',
				'role'       => 'primary',
				'generation' => 1,
				'added'      => '2026-10-26',
				'jwk'        => array(
					'kty' => 'OKP',
					'crv' => 'Ed25519',
					'x'   => 'PcUCBGLBJ4zjasNQKZJI5FupfvUDtyey6NeLpxwaJyk',
				),
			),
			array(
				'kid'        => '8l853J2OG3QMQmih_3xjxkE6kL-aYERKjaCza171yBQ',
				'role'       => 'backup',
				'generation' => 2,
				'added'      => '2026-10-26',
				'jwk'        => array(
					'kty' => 'OKP',
					'crv' => 'Ed25519',
					'x'   => 'eOX0yQWZuN2z500aITEU5gcu4_PqVKsaZ2bZIW7Z7iE',
				),
			),
		);
	}
}
