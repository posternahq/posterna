<?php
/**
 * The runtime proxy guard (docs/SPEC.md section 4.2).
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * Notices the misconfiguration that would make real crawlers look spoofed:
 * if 80 percent or more of the last 200 requests resolve to internal
 * addresses, the site is almost certainly behind a proxy it has not been
 * told about. In WordPress each request is its own process, so the plugin
 * keeps the same ratio from its hourly counters; this in-memory window is
 * what the conformance vectors check.
 */
final class Proxy_Guard {

	/**
	 * Ring of 0 and 1 values.
	 *
	 * @var array
	 */
	private $window = array();

	/**
	 * Next slot.
	 *
	 * @var int
	 */
	private $next = 0;

	/**
	 * Internal addresses in the window.
	 *
	 * @var int
	 */
	private $internal = 0;

	/**
	 * Window size.
	 *
	 * @var int
	 */
	private $size;

	/**
	 * Share of internal addresses that marks the install suspect.
	 *
	 * @var float
	 */
	private $threshold;

	/**
	 * Creates a guard.
	 *
	 * @param int   $size      Window size.
	 * @param float $threshold Share that trips it.
	 */
	public function __construct( $size = 200, $threshold = 0.8 ) {
		$this->size      = $size;
		$this->threshold = $threshold;
	}

	/**
	 * Records one resolved client address. Requests with no address are not counted.
	 *
	 * @param Address|null $address Address.
	 */
	public function record( $address ) {
		if ( null === $address ) {
			return;
		}
		$value = $address->internal ? 1 : 0;
		if ( count( $this->window ) === $this->size ) {
			$this->internal -= $this->window[ $this->next ];
		}
		$this->window[ $this->next ] = $value;
		$this->internal             += $value;
		$this->next                  = ( $this->next + 1 ) % $this->size;
	}

	/**
	 * True when the window is full and mostly internal.
	 *
	 * @return bool
	 */
	public function suspect() {
		return count( $this->window ) === $this->size && $this->internal >= $this->size * $this->threshold;
	}
}
