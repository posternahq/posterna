<?php
/**
 * Where the compiled directory is kept between requests.
 *
 * @package Posterna
 */

namespace Posterna\Directory;

defined( 'ABSPATH' ) || exit;

/**
 * In the plugin, options; in tests, memory.
 */
interface Directory_Storage {

	/**
	 * The saved state (compiled directory and keys, versions, generations), or null.
	 *
	 * @return array|null
	 */
	public function get_state();

	/**
	 * Saves the state.
	 *
	 * @param array $state State.
	 */
	public function put_state( $state );

	/**
	 * One operator's packed IP ranges, or null.
	 *
	 * @param string $slug Operator slug.
	 * @return array|null
	 */
	public function get_ranges( $slug );

	/**
	 * Replaces every operator's ranges.
	 *
	 * @param array $ranges Slug => packed ranges.
	 */
	public function put_ranges( $ranges );
}
