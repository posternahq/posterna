<?php
/**
 * Nonces seen, for replay detection.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * In the plugin, nonces live in transients for as long as a signature can be
 * valid; in tests they live in memory.
 */
interface Nonce_Store {

	/**
	 * True when the key was seen before.
	 *
	 * @param string $key Operator, keyid and nonce.
	 * @return bool
	 */
	public function has( $key );

	/**
	 * Remembers a key.
	 *
	 * @param string $key Operator, keyid and nonce.
	 */
	public function add( $key );
}
