<?php
/**
 * IPv4 and IPv6 prefix matching.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * Prefixes compiled into sorted, merged ranges, so a lookup is a binary
 * search. Ranges are packed into one string per family (fixed-width hex
 * start and end), which stores compactly in an option and loads fast.
 */
final class Prefix_Matcher {

	/**
	 * IPv4 ranges: 16 hex characters each (start, end).
	 *
	 * @var string
	 */
	public $v4 = '';

	/**
	 * IPv6 ranges: 64 hex characters each (start, end).
	 *
	 * @var string
	 */
	public $v6 = '';

	/**
	 * Prefixes that could not be parsed and were left out.
	 *
	 * @var int
	 */
	public $invalid = 0;

	/**
	 * Compiles CIDR strings. Invalid entries are counted and skipped, never thrown.
	 *
	 * @param array $prefixes CIDR strings.
	 * @return Prefix_Matcher
	 */
	public static function compile( $prefixes ) {
		$matcher = new self();
		$ranges  = array(
			'v4' => array(),
			'v6' => array(),
		);
		foreach ( (array) $prefixes as $prefix ) {
			$range = self::range( is_string( $prefix ) ? trim( $prefix ) : '' );
			if ( null === $range ) {
				++$matcher->invalid;
				continue;
			}
			$family              = 8 === strlen( $range[0] ) ? 'v4' : 'v6';
			$ranges[ $family ][] = $range;
		}
		foreach ( $ranges as $family => $list ) {
			usort(
				$list,
				function ( $a, $b ) {
					return strcmp( $a[0], $b[0] );
				}
			);
			$merged = array();
			foreach ( $list as $range ) {
				$last = count( $merged ) - 1;
				if ( $last >= 0 && strcmp( $range[0], $merged[ $last ][1] ) <= 0 ) {
					if ( strcmp( $range[1], $merged[ $last ][1] ) > 0 ) {
						$merged[ $last ][1] = $range[1];
					}
				} else {
					$merged[] = $range;
				}
			}
			$packed = '';
			foreach ( $merged as $range ) {
				$packed .= $range[0] . $range[1];
			}
			$matcher->$family = $packed;
		}
		return $matcher;
	}

	/**
	 * Restores a matcher from its packed form.
	 *
	 * @param array $packed array( 'v4' => string, 'v6' => string ).
	 * @return Prefix_Matcher
	 */
	public static function from_packed( $packed ) {
		$matcher     = new self();
		$matcher->v4 = isset( $packed['v4'] ) && is_string( $packed['v4'] ) ? $packed['v4'] : '';
		$matcher->v6 = isset( $packed['v6'] ) && is_string( $packed['v6'] ) ? $packed['v6'] : '';
		return $matcher;
	}

	/**
	 * The packed form.
	 *
	 * @return array
	 */
	public function to_packed() {
		return array(
			'v4' => $this->v4,
			'v6' => $this->v6,
		);
	}

	/**
	 * Hex start and end of a CIDR, or null when it is not one.
	 *
	 * @param string $cidr CIDR text.
	 * @return array|null
	 */
	private static function range( $cidr ) {
		$slash = strpos( $cidr, '/' );
		if ( false === $slash ) {
			return null;
		}
		$text   = substr( $cidr, 0, $slash );
		$length = substr( $cidr, $slash + 1 );
		if ( ! preg_match( '/^\d{1,3}$/', $length ) ) {
			return null;
		}
		$length = (int) $length;
		if ( false !== strpos( $text, ':' ) ) {
			if ( false === filter_var( $text, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6 ) || $length > 128 ) {
				return null;
			}
		} elseif ( ! preg_match( '/^\d{1,3}(\.\d{1,3}){3}$/', $text ) || false === filter_var( $text, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4 ) || $length > 32 ) {
			return null;
		}
		$bytes = inet_pton( $text );
		if ( false === $bytes ) {
			return null;
		}
		$start = '';
		$end   = '';
		$count = strlen( $bytes );
		for ( $i = 0; $i < $count; $i++ ) {
			$bits   = max( 0, min( 8, $length - $i * 8 ) );
			$mask   = ( 0xff << ( 8 - $bits ) ) & 0xff;
			$byte   = ord( $bytes[ $i ] );
			$start .= chr( $byte & $mask );
			$end   .= chr( ( $byte & $mask ) | ( ~$mask & 0xff ) );
		}
		return array( bin2hex( $start ), bin2hex( $end ) );
	}

	/**
	 * True when the address is inside one of the ranges.
	 *
	 * @param Address $address Address.
	 * @return bool
	 */
	public function has( $address ) {
		$packed = 'ipv4' === $address->family ? $this->v4 : $this->v6;
		$width  = 'ipv4' === $address->family ? 8 : 32;
		$size   = $width * 2;
		$count  = intdiv( strlen( $packed ), $size );
		$low    = 0;
		$high   = $count;
		while ( $low < $high ) {
			$middle = ( $low + $high ) >> 1;
			if ( strcmp( substr( $packed, $middle * $size, $width ), $address->hex ) <= 0 ) {
				$low = $middle + 1;
			} else {
				$high = $middle;
			}
		}
		$index = $low - 1;
		return $index >= 0 && strcmp( $address->hex, substr( $packed, $index * $size + $width, $width ) ) <= 0;
	}

	/**
	 * Number of merged ranges.
	 *
	 * @return int
	 */
	public function size() {
		return intdiv( strlen( $this->v4 ), 16 ) + intdiv( strlen( $this->v6 ), 64 );
	}
}
