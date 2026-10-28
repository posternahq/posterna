<?php
/**
 * Signature nonces in transients, for replay detection.
 *
 * @package Posterna
 */

namespace Posterna;

use Posterna\Verifier\Nonce_Store;

defined( 'ABSPATH' ) || exit;

/**
 * A nonce is kept for the longest time a signature may be valid plus clock
 * skew; after that the signature has expired anyway, so a replay fails.
 */
final class Transient_Nonce_Store implements Nonce_Store {

	const TTL = 3660;

	/**
	 * The transient name for a key.
	 *
	 * @param string $key Key.
	 * @return string
	 */
	private static function name( $key ) {
		return 'posterna_nonce_' . md5( $key );
	}

	/**
	 * True when the key was seen before.
	 *
	 * @param string $key Key.
	 * @return bool
	 */
	public function has( $key ) {
		return false !== get_transient( self::name( $key ) );
	}

	/**
	 * Remembers a key.
	 *
	 * @param string $key Key.
	 */
	public function add( $key ) {
		set_transient( self::name( $key ), 1, self::TTL );
	}
}
