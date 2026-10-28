<?php
/**
 * A Structured Field date (RFC 9651 section 3.3.7).
 *
 * @package Posterna
 */

namespace Posterna\Signature;

defined( 'ABSPATH' ) || exit;

/**
 * Parsed so it can be refused: HTTP Message Signatures (RFC 9421) builds on
 * RFC 8941, which has no dates.
 */
final class Sf_Date {

	/**
	 * Seconds since the epoch.
	 *
	 * @var int
	 */
	public $seconds;

	/**
	 * Wraps a date.
	 *
	 * @param int $seconds Seconds since the epoch.
	 */
	public function __construct( $seconds ) {
		$this->seconds = $seconds;
	}
}
