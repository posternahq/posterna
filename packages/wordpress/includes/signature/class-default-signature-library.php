<?php
/**
 * The signature functions the plugin uses.
 *
 * @package Posterna
 */

namespace Posterna\Signature;

defined( 'ABSPATH' ) || exit;

/**
 * Calls the Web Bot Auth and RFC 9421 ports.
 */
final class Default_Signature_Library implements Signature_Library {

	/**
	 * Verifies a Web Bot Auth signature that carries an alg parameter.
	 *
	 * @param array $request Request descriptor.
	 * @param array $options See Web_Bot_Auth::verify().
	 * @return array
	 */
	public function web_bot_auth_verify( $request, $options ) {
		return Web_Bot_Auth::verify( $request, $options );
	}

	/**
	 * Verifies an RFC 9421 signature.
	 *
	 * @param array $request Request descriptor.
	 * @param array $options See Message_Signature::verify().
	 * @return array
	 */
	public function verify_signature( $request, $options ) {
		return Message_Signature::verify( $request, $options );
	}
}
