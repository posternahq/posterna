<?php
/**
 * The compiled directory, kept in options.
 *
 * @package Posterna
 */

namespace Posterna;

use Posterna\Directory\Directory_Storage;

defined( 'ABSPATH' ) || exit;

/**
 * The lookups every request needs (user-agent tokens, signing origins,
 * operators and keys) are one autoloaded option, so reading them costs no
 * extra query. IP ranges are one option per operator, loaded only when a
 * request claims that operator.
 */
final class Options_Directory_Storage implements Directory_Storage {

	const STATE_OPTION  = 'posterna_directory';
	const RANGES_PREFIX = 'posterna_ranges_';

	/**
	 * The saved state, or null.
	 *
	 * @return array|null
	 */
	public function get_state() {
		$state = get_option( self::STATE_OPTION, null );
		return is_array( $state ) ? $state : null;
	}

	/**
	 * Saves the state.
	 *
	 * @param array $state State.
	 */
	public function put_state( $state ) {
		$previous = $this->get_state();
		if ( is_array( $previous ) && isset( $previous['range_slugs'] ) && ! isset( $state['range_slugs'] ) ) {
			$state['range_slugs'] = $previous['range_slugs'];
		}
		update_option( self::STATE_OPTION, $state, true );
	}

	/**
	 * One operator's packed IP ranges, or null.
	 *
	 * @param string $slug Slug.
	 * @return array|null
	 */
	public function get_ranges( $slug ) {
		$ranges = get_option( self::RANGES_PREFIX . sanitize_key( $slug ), null );
		return is_array( $ranges ) ? $ranges : null;
	}

	/**
	 * Replaces every operator's ranges and removes ranges of operators that left.
	 *
	 * @param array $ranges Slug => packed ranges.
	 */
	public function put_ranges( $ranges ) {
		$state = $this->get_state();
		$old   = is_array( $state ) && isset( $state['range_slugs'] ) && is_array( $state['range_slugs'] ) ? $state['range_slugs'] : array();
		foreach ( $ranges as $slug => $packed ) {
			update_option( self::RANGES_PREFIX . sanitize_key( $slug ), $packed, false );
		}
		foreach ( array_diff( $old, array_keys( $ranges ) ) as $slug ) {
			delete_option( self::RANGES_PREFIX . sanitize_key( $slug ) );
		}
		$state                = is_array( $state ) ? $state : array();
		$state['range_slugs'] = array_map( 'strval', array_keys( $ranges ) );
		update_option( self::STATE_OPTION, $state, true );
	}
}
