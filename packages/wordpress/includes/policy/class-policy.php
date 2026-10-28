<?php
/**
 * The parts of an agents.yaml policy the robots.txt suggestions read.
 *
 * @package Posterna
 */

namespace Posterna\Policy;

defined( 'ABSPATH' ) || exit;

/**
 * Plugin version 1.0 runs in monitor mode only and has no policy engine. It
 * uses the shipped templates to suggest robots.txt lines (docs/SPEC.md
 * section 5.6). A policy here is a normalized array with the keys defaults
 * (class => spec), guards (search_engines => protect or off), purposes
 * (purpose => spec), operators (slug => purpose => spec), paths (a list of
 * pattern and rules) and emit (a list). A spec is array( 'action' => allow,
 * block or throttle ).
 */
final class Policy {

	const PURPOSES = array( 'training', 'search', 'user_fetch', 'agent', 'preview', 'ads', 'other' );

	/**
	 * The templates the plugin offers, as agents.yaml would parse. They match
	 * packages/core/templates/monitor.yaml and allow-list.yaml; a test keeps them equal.
	 *
	 * @return array Name => raw policy.
	 */
	public static function templates() {
		$defaults = array(
			'verified'              => 'allow',
			'declared_unverifiable' => 'allow',
			'claimed_failed'        => 'allow',
			'unknown_automation'    => 'allow',
		);
		return array(
			'monitor'    => array(
				'version'  => 1,
				'mode'     => 'monitor',
				'defaults' => $defaults,
				'guards'   => array( 'search_engines' => 'protect' ),
				'emit'     => array( 'robots.txt', 'content-signals' ),
			),
			'allow-list' => array(
				'version'  => 1,
				'mode'     => 'monitor',
				'defaults' => $defaults,
				'guards'   => array( 'search_engines' => 'protect' ),
				'purposes' => array( 'training' => 'block' ),
				'emit'     => array( 'robots.txt', 'content-signals' ),
			),
		);
	}

	/**
	 * Normalizes one action spec: "block" or array( 'action' => 'block', ... ).
	 *
	 * @param mixed $raw Raw spec.
	 * @return array|null
	 */
	private static function spec( $raw ) {
		if ( is_string( $raw ) ) {
			return array( 'action' => $raw );
		}
		if ( is_array( $raw ) && isset( $raw['action'] ) && is_string( $raw['action'] ) ) {
			return array( 'action' => $raw['action'] );
		}
		return null;
	}

	/**
	 * Normalizes a map of key => spec.
	 *
	 * @param mixed $raw Raw map.
	 * @return array
	 */
	private static function specs( $raw ) {
		$out = array();
		foreach ( is_array( $raw ) ? $raw : array() as $key => $value ) {
			$spec = self::spec( $value );
			if ( null !== $spec ) {
				$out[ (string) $key ] = $spec;
			}
		}
		return $out;
	}

	/**
	 * Normalizes a parsed agents.yaml (or a template).
	 *
	 * @param array $raw Parsed policy.
	 * @return array
	 */
	public static function from_array( $raw ) {
		$guards    = isset( $raw['guards']['search_engines'] ) && 'off' === $raw['guards']['search_engines'] ? 'off' : 'protect';
		$operators = array();
		foreach ( isset( $raw['operators'] ) && is_array( $raw['operators'] ) ? $raw['operators'] : array() as $slug => $rules ) {
			$operators[ (string) $slug ] = self::specs( $rules );
		}
		$paths = array();
		foreach ( isset( $raw['paths'] ) && is_array( $raw['paths'] ) ? $raw['paths'] : array() as $pattern => $rules ) {
			$specs = self::specs( $rules );
			unset( $specs['monitor'] );
			$paths[] = array(
				'pattern' => (string) $pattern,
				'rules'   => $specs,
			);
		}
		return array(
			'defaults'  => self::specs( isset( $raw['defaults'] ) ? $raw['defaults'] : array() ),
			'guards'    => array( 'search_engines' => $guards ),
			'purposes'  => self::specs( isset( $raw['purposes'] ) ? $raw['purposes'] : array() ),
			'operators' => $operators,
			'paths'     => $paths,
			'emit'      => isset( $raw['emit'] ) && is_array( $raw['emit'] ) ? array_values( array_filter( $raw['emit'], 'is_string' ) ) : array(),
		);
	}
}
