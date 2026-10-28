<?php
/**
 * Counter path groups (docs/SPEC.md section 7).
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * A port of firstSegmentGroup() in packages/core/src/policy/engine.ts:
 * /docs/intro is /docs/*, a file at the root such as /robots.txt is itself,
 * / is /, and identifier-like segments are masked as /:id/*, so no user
 * name, number or token in a URL is ever counted.
 */
final class Path_Group {

	/**
	 * The group for a path (without the query).
	 *
	 * @param string $path Path.
	 * @return string
	 */
	public static function first_segment( $path ) {
		$parts = array_values(
			array_filter(
				explode( '/', (string) $path ),
				'strlen'
			)
		);
		if ( array() === $parts ) {
			return '/';
		}
		$raw     = $parts[0];
		$segment = rawurldecode( $raw );
		// A file extension must not hide an identifier, as in /<uuid>.png.
		$extension = preg_match( '/\.[A-Za-z0-9]{1,10}$/', $segment, $match ) ? $match[0] : '';
		$stem      = substr( $segment, 0, strlen( $segment ) - strlen( $extension ) );
		if ( self::looks_like_id( $segment ) || ( '' !== $extension && self::looks_like_id( $stem ) ) ) {
			return '/:id/*';
		}
		$file = 1 === count( $parts ) && '/' !== substr( (string) $path, -1 ) && '' !== $extension && '' !== $stem;
		return $file ? '/' . $segment : '/' . $segment . '/*';
	}

	/**
	 * Digits, a UUID, long hex or token-like strings, anything with @, % or
	 * spaces, or over 32 characters.
	 *
	 * @param string $segment Decoded segment.
	 * @return bool
	 */
	private static function looks_like_id( $segment ) {
		return strlen( $segment ) > 32
			|| preg_match( '/[@%\s]/', $segment )
			|| preg_match( '/^\d[\d_.-]*$/', $segment )
			|| preg_match( '/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i', $segment )
			|| preg_match( '/^[0-9a-f]{12,}$/i', $segment )
			|| ( preg_match( '/\d/', $segment ) && preg_match( '/^[A-Za-z0-9_-]{16,}$/', $segment ) )
			|| ! preg_match( '/^[A-Za-z0-9._~-]+$/', $segment );
	}
}
