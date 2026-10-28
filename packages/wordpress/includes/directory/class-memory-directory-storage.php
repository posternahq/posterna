<?php
/**
 * The compiled directory kept in memory.
 *
 * @package Posterna
 */

namespace Posterna\Directory;

defined( 'ABSPATH' ) || exit;

/**
 * Used by the conformance tests and the benchmark.
 */
final class Memory_Directory_Storage implements Directory_Storage {

	/**
	 * State.
	 *
	 * @var array|null
	 */
	private $state = null;

	/**
	 * Ranges by slug.
	 *
	 * @var array
	 */
	private $ranges = array();

	/**
	 * The saved state, or null.
	 *
	 * @return array|null
	 */
	public function get_state() {
		return $this->state;
	}

	/**
	 * Saves the state.
	 *
	 * @param array $state State.
	 */
	public function put_state( $state ) {
		$this->state = $state;
	}

	/**
	 * One operator's ranges, or null.
	 *
	 * @param string $slug Slug.
	 * @return array|null
	 */
	public function get_ranges( $slug ) {
		return isset( $this->ranges[ $slug ] ) ? $this->ranges[ $slug ] : null;
	}

	/**
	 * Replaces every operator's ranges.
	 *
	 * @param array $ranges Slug => packed ranges.
	 */
	public function put_ranges( $ranges ) {
		$this->ranges = $ranges;
	}
}
