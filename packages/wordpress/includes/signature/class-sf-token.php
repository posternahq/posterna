<?php
/**
 * A Structured Field token (RFC 9651 section 3.3.4).
 *
 * @package Posterna
 */

namespace Posterna\Signature;

defined( 'ABSPATH' ) || exit;

/**
 * Tokens are kept apart from strings because HTTP Message Signatures treats
 * them differently: a keyid or a Signature-Agent value must be a string.
 */
final class Sf_Token {

	/**
	 * The token text.
	 *
	 * @var string
	 */
	public $value;

	/**
	 * Creates a token.
	 *
	 * @param string $value Token text.
	 * @throws Sf_Error When the text is not a valid token.
	 */
	public function __construct( $value ) {
		if ( ! preg_match( '/^[a-zA-Z*][:\/!#$%&\'*+\-.^_`|~A-Za-z0-9]*$/', $value ) ) {
			$exception = new Sf_Error( 'Invalid character in token' );
			throw $exception;
		}
		$this->value = $value;
	}

	/**
	 * The token text.
	 *
	 * @return string
	 */
	public function __toString() {
		return $this->value;
	}
}
