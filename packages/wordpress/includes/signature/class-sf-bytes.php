<?php
/**
 * A Structured Field byte sequence (RFC 9651 section 3.3.5).
 *
 * @package Posterna
 */

namespace Posterna\Signature;

defined( 'ABSPATH' ) || exit;

/**
 * Raw bytes, kept apart from strings so the serializer knows to base64 them.
 */
final class Sf_Bytes {

	/**
	 * The decoded bytes.
	 *
	 * @var string
	 */
	public $bytes;

	/**
	 * Wraps decoded bytes.
	 *
	 * @param string $bytes Binary string.
	 */
	public function __construct( $bytes ) {
		$this->bytes = $bytes;
	}
}
