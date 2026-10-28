<?php
/**
 * The parts of URL parsing the verifier needs, following the WHATWG URL
 * standard that Posterna's TypeScript core gets from `new URL()`.
 *
 * Only http and https URLs are read in detail. That is enough for
 * `@authority`, `@scheme` and Signature-Agent origins. Anything this parser
 * does not understand is treated as invalid, which makes a signature fail to
 * verify or a Signature-Agent be ignored; it never makes one pass.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * Small WHATWG-style URL reader.
 */
final class Url {

	const DEFAULT_PORTS = array(
		'http'  => 80,
		'https' => 443,
		'ws'    => 80,
		'wss'   => 443,
		'ftp'   => 21,
	);

	/**
	 * Parses an absolute URL.
	 *
	 * @param string $input URL text.
	 * @return array|null array( scheme, host, pathname, search, hash, userinfo ) with
	 *                    host as WHATWG serializes it (lowercase, default port removed),
	 *                    or null when the URL is invalid.
	 */
	public static function parse( $input ) {
		if ( ! is_string( $input ) ) {
			return null;
		}
		// Leading and trailing C0 controls and spaces are removed, as are tabs and newlines anywhere.
		$url = trim( $input, "\x00..\x20" );
		$url = str_replace( array( "\t", "\n", "\r" ), '', $url );
		if ( ! preg_match( '/^([A-Za-z][A-Za-z0-9+\-.]*):(.*)$/s', $url, $match ) ) {
			return null;
		}
		$scheme = strtolower( $match[1] );
		$rest   = $match[2];
		if ( ! isset( self::DEFAULT_PORTS[ $scheme ] ) ) {
			// A non-special scheme: valid, but nothing here needs its parts.
			return array(
				'scheme'   => $scheme,
				'host'     => '',
				'pathname' => '',
				'search'   => '',
				'hash'     => '',
				'userinfo' => false,
			);
		}
		// Special schemes ignore any number of slashes or backslashes before the authority.
		$rest     = ltrim( $rest, '/\\' );
		$length   = strcspn( $rest, '/\\?#' );
		$userinfo = false;
		$host     = substr( $rest, 0, $length );
		$after    = (string) substr( $rest, $length );
		$at       = strrpos( $host, '@' );
		if ( false !== $at ) {
			$userinfo = true;
			$host     = substr( $host, $at + 1 );
		}
		$host = self::host( $host, self::DEFAULT_PORTS[ $scheme ] );
		if ( null === $host ) {
			return null;
		}
		$hash = '';
		$hpos = strpos( $after, '#' );
		if ( false !== $hpos ) {
			$hash  = substr( $after, $hpos );
			$after = substr( $after, 0, $hpos );
		}
		$search = '';
		$qpos   = strpos( $after, '?' );
		if ( false !== $qpos ) {
			$search = substr( $after, $qpos );
			$after  = substr( $after, 0, $qpos );
		}
		return array(
			'scheme'   => $scheme,
			'host'     => $host,
			'pathname' => self::pathname( $after ),
			'search'   => '?' === $search ? '' : $search,
			'hash'     => '#' === $hash ? '' : $hash,
			'userinfo' => $userinfo,
		);
	}

	/**
	 * The origin of an https URL, or null for any other URL.
	 *
	 * @param string $input URL text.
	 * @return string|null
	 */
	public static function https_origin( $input ) {
		$url = self::parse( $input );
		if ( null === $url || 'https' !== $url['scheme'] ) {
			return null;
		}
		return 'https://' . $url['host'];
	}

	/**
	 * The origin a Signature-Agent member names, when it is a valid directory
	 * member: an https origin with no path other than "/", no credentials, query
	 * or fragment (draft-ietf-webbotauth-httpsig-protocol section 5.5).
	 *
	 * @param string $input URL text.
	 * @return string|null
	 */
	public static function signature_agent_origin( $input ) {
		$url = self::parse( $input );
		if ( null === $url || 'https' !== $url['scheme'] || $url['userinfo'] ) {
			return null;
		}
		if ( '/' !== $url['pathname'] && '' !== $url['pathname'] ) {
			return null;
		}
		if ( '' !== $url['search'] || '' !== $url['hash'] ) {
			return null;
		}
		return 'https://' . $url['host'];
	}

	/**
	 * Parses a host and port as WHATWG does for special schemes.
	 *
	 * @param string $raw          Host and optional port.
	 * @param int    $default_port The scheme's default port.
	 * @return string|null Serialized host, or null when invalid.
	 */
	private static function host( $raw, $default_port ) {
		$port = '';
		if ( '' !== $raw && '[' === $raw[0] ) {
			$close = strpos( $raw, ']' );
			if ( false === $close ) {
				return null;
			}
			$inside = substr( $raw, 1, $close - 1 );
			$tail   = (string) substr( $raw, $close + 1 );
			if ( '' !== $tail ) {
				if ( ':' !== $tail[0] ) {
					return null;
				}
				$port = substr( $tail, 1 );
			}
			$address = Address::parse( '[' . $inside . ']' );
			if ( null === $address || 'ipv6' !== $address->family || false !== strpos( $inside, '%' ) ) {
				return null;
			}
			$host = '[' . $address->rfc5952_v6() . ']';
		} else {
			$colon = strrpos( $raw, ':' );
			if ( false !== $colon ) {
				$port = substr( $raw, $colon + 1 );
				$raw  = substr( $raw, 0, $colon );
			}
			$host = self::domain( $raw );
			if ( null === $host ) {
				return null;
			}
		}
		if ( '' !== $port ) {
			if ( ! preg_match( '/^[0-9]+$/', $port ) ) {
				return null;
			}
			$number = (int) ltrim( $port, '0' );
			if ( strlen( ltrim( $port, '0' ) ) > 5 || $number > 65535 ) {
				return null;
			}
			if ( $number !== $default_port ) {
				$host .= ':' . $number;
			}
		}
		return $host;
	}

	/**
	 * Parses a domain or IPv4 host. Non-ASCII and percent-encoded hosts are
	 * refused rather than converted, which only ever makes a check fail.
	 *
	 * @param string $raw Host text.
	 * @return string|null
	 */
	private static function domain( $raw ) {
		if ( '' === $raw ) {
			return null;
		}
		// Forbidden domain code points, plus anything non-ASCII.
		if ( preg_match( '/[\x00-\x20#\/:<>?@\[\\\\\]^|%\x7f-\xff]/', $raw ) ) {
			return null;
		}
		$host   = strtolower( $raw );
		$labels = explode( '.', $host );
		$last   = end( $labels );
		if ( '' === $last && count( $labels ) > 1 ) {
			$last = $labels[ count( $labels ) - 2 ];
		}
		// A host that ends in a number is an IPv4 address and must parse as one.
		if ( preg_match( '/^(0x[0-9a-f]*|[0-9]+)$/', $last ) ) {
			return self::ipv4( $host );
		}
		return $host;
	}

	/**
	 * Parses an IPv4 host the WHATWG way: one to four parts, each decimal,
	 * octal (leading 0) or hex (0x).
	 *
	 * @param string $host Lowercase host.
	 * @return string|null Dotted quad, or null when invalid.
	 */
	private static function ipv4( $host ) {
		$parts = explode( '.', $host );
		if ( '' === end( $parts ) && count( $parts ) > 1 ) {
			array_pop( $parts );
		}
		if ( count( $parts ) > 4 ) {
			return null;
		}
		$numbers = array();
		foreach ( $parts as $part ) {
			if ( '' === $part ) {
				return null;
			}
			if ( preg_match( '/^0x([0-9a-f]*)$/', $part, $hex ) ) {
				$value = '' === $hex[1] ? 0 : hexdec( $hex[1] );
			} elseif ( preg_match( '/^0([0-7]+)$/', $part, $oct ) ) {
				$value = octdec( $oct[1] );
			} elseif ( preg_match( '/^[0-9]+$/', $part ) ) {
				$value = (float) $part;
			} else {
				return null;
			}
			$numbers[] = $value;
		}
		$last = array_pop( $numbers );
		foreach ( $numbers as $number ) {
			if ( $number > 255 ) {
				return null;
			}
		}
		if ( $last >= pow( 256, 5 - count( $parts ) ) ) {
			return null;
		}
		$value = $last;
		foreach ( $numbers as $index => $number ) {
			$value += $number * pow( 256, 3 - $index );
		}
		$value = (int) $value;
		return implode( '.', array( ( $value >> 24 ) & 255, ( $value >> 16 ) & 255, ( $value >> 8 ) & 255, $value & 255 ) );
	}

	/**
	 * A special-scheme path with backslashes as slashes and dot segments removed.
	 *
	 * @param string $path Raw path.
	 * @return string
	 */
	private static function pathname( $path ) {
		$path = str_replace( '\\', '/', $path );
		if ( '' === $path ) {
			return '/';
		}
		$output   = array();
		$segments = explode( '/', substr( $path, 1 ) );
		$count    = count( $segments );
		foreach ( $segments as $index => $segment ) {
			$lower = strtolower( $segment );
			$last  = $index === $count - 1;
			if ( '..' === $lower || '.%2e' === $lower || '%2e.' === $lower || '%2e%2e' === $lower ) {
				array_pop( $output );
				if ( $last ) {
					$output[] = '';
				}
			} elseif ( '.' === $lower || '%2e' === $lower ) {
				if ( $last ) {
					$output[] = '';
				}
			} else {
				$output[] = $segment;
			}
		}
		return '/' . implode( '/', $output );
	}
}
