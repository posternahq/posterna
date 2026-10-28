<?php
/**
 * The compiled directory, as the verifier reads it on each request.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * Lookups over the compiled directory and keys. IP ranges are loaded only
 * for an operator a request claims, so most requests never read them.
 */
final class Directory_Index {

	/**
	 * Compiled directory from Index_Builder::compile_directory().
	 *
	 * @var array
	 */
	private $directory;

	/**
	 * Compiled keys from Index_Builder::compile_keys(), or null.
	 *
	 * @var array|null
	 */
	private $keys;

	/**
	 * Returns an operator's packed ranges: callable( string $slug ): array|null.
	 *
	 * @var callable
	 */
	private $ranges_loader;

	/**
	 * Matchers built so far, by slug and list.
	 *
	 * @var array
	 */
	private $matchers = array();

	/**
	 * Creates the index.
	 *
	 * @param array      $directory     Compiled directory.
	 * @param array|null $keys          Compiled keys.
	 * @param callable   $ranges_loader Loads one operator's ranges.
	 */
	public function __construct( $directory, $keys, $ranges_loader ) {
		$this->directory     = $directory;
		$this->keys          = $keys;
		$this->ranges_loader = $ranges_loader;
	}

	/**
	 * The directory version, YYYY-MM-DD.
	 *
	 * @return string|null
	 */
	public function directory_version() {
		return $this->directory['version'];
	}

	/**
	 * The keys version, YYYY-MM-DDTHH.
	 *
	 * @return string|null
	 */
	public function keys_version() {
		return null === $this->keys ? null : $this->keys['version'];
	}

	/**
	 * Every operator, by slug, in directory order.
	 *
	 * @return array
	 */
	public function operators() {
		return $this->directory['operators'];
	}

	/**
	 * One operator, or null.
	 *
	 * @param string $slug Slug.
	 * @return array|null
	 */
	public function operator( $slug ) {
		return isset( $this->directory['operators'][ $slug ] ) ? $this->directory['operators'][ $slug ] : null;
	}

	/**
	 * The agent a token names: array( slug, position, coverage ), or null.
	 *
	 * @param string $lower Lowercase token.
	 * @return array|null
	 */
	public function token( $lower ) {
		return isset( $this->directory['tokens'][ $lower ] ) ? $this->directory['tokens'][ $lower ] : null;
	}

	/**
	 * Phrase patterns, longest first: list of array( pattern, slug, position, length ).
	 *
	 * @return array
	 */
	public function phrases() {
		return $this->directory['phrases'];
	}

	/**
	 * The operator whose key directory is at this origin, or null.
	 *
	 * @param string $origin Origin.
	 * @return string|null
	 */
	public function signing_origin( $origin ) {
		return isset( $this->directory['origins'][ $origin ] ) ? $this->directory['origins'][ $origin ] : null;
	}

	/**
	 * An operator's keys: array( 'uses_kid' => bool, 'keys' => list ), or null.
	 *
	 * @param string $slug Slug.
	 * @return array|null
	 */
	public function keys( $slug ) {
		if ( null === $this->keys || ! isset( $this->keys['operators'][ $slug ], $this->directory['operators'][ $slug ] ) ) {
			return null;
		}
		return $this->keys['operators'][ $slug ];
	}

	/**
	 * The number of keys held for an operator.
	 *
	 * @param string $slug Slug.
	 * @return int
	 */
	public function key_count( $slug ) {
		$keys = $this->keys( $slug );
		return null === $keys ? 0 : count( $keys['keys'] );
	}

	/**
	 * Keys left out when compiling, with the reason.
	 *
	 * @return array
	 */
	public function skipped_keys() {
		$skipped = array();
		if ( null !== $this->keys ) {
			foreach ( $this->keys['skipped'] as $line ) {
				$slug = substr( $line, 0, (int) strpos( $line, ':' ) );
				if ( isset( $this->directory['operators'][ $slug ] ) ) {
					$skipped[] = $line;
				}
			}
		}
		return $skipped;
	}

	/**
	 * The matcher for an agent: its own list when it names one the operator
	 * publishes, else all of the operator's lists. Null when the operator
	 * publishes no lists.
	 *
	 * @param string      $slug       Operator slug.
	 * @param string|null $list_agent The agent's ip_list_agent.
	 * @return Prefix_Matcher|null
	 */
	public function ip_matcher( $slug, $list_agent ) {
		$operator = $this->operator( $slug );
		if ( null === $operator || ! $operator['has_lists'] ) {
			return null;
		}
		if ( ! array_key_exists( $slug, $this->matchers ) ) {
			$ranges                  = call_user_func( $this->ranges_loader, $slug );
			$this->matchers[ $slug ] = is_array( $ranges ) ? $ranges : array(
				'lists' => array(),
				'all'   => null,
			);
		}
		$ranges = $this->matchers[ $slug ];
		if ( null !== $list_agent && isset( $ranges['lists'][ $list_agent ] ) ) {
			return Prefix_Matcher::from_packed( $ranges['lists'][ $list_agent ] );
		}
		if ( null !== $ranges['all'] ) {
			return Prefix_Matcher::from_packed( $ranges['all'] );
		}
		$lists = array_values( $ranges['lists'] );
		return Prefix_Matcher::from_packed( isset( $lists[0] ) ? $lists[0] : array() );
	}
}
