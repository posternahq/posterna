<?php
/**
 * A Structured Field display string (RFC 9651 section 3.3.8).
 *
 * @package Posterna
 */

namespace Posterna\Signature;

defined( 'ABSPATH' ) || exit;

/**
 * Parsed so it can be refused: HTTP Message Signatures (RFC 9421) builds on
 * RFC 8941, which has no display strings.
 */
final class Sf_Display_String {

	/**
	 * The decoded UTF-8 text.
	 *
	 * @var string
	 */
	public $text;

	/**
	 * Wraps decoded text.
	 *
	 * @param string $text UTF-8 text.
	 */
	public function __construct( $text ) {
		$this->text = $text;
	}
}
