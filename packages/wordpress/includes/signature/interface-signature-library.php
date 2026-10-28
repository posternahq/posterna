<?php
/**
 * The two signature functions the signature path calls.
 *
 * @package Posterna
 */

namespace Posterna\Signature;

defined( 'ABSPATH' ) || exit;

/**
 * Tests replace these to inject failures; the plugin always uses
 * Default_Signature_Library.
 */
interface Signature_Library {

	/**
	 * Verifies a Web Bot Auth signature that carries an alg parameter.
	 *
	 * @param array $request Request descriptor.
	 * @param array $options See Web_Bot_Auth::verify().
	 * @return array
	 */
	public function web_bot_auth_verify( $request, $options );

	/**
	 * Verifies an RFC 9421 signature.
	 *
	 * @param array $request Request descriptor.
	 * @param array $options See Message_Signature::verify().
	 * @return array
	 */
	public function verify_signature( $request, $options );
}
