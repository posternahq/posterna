<?php
/**
 * IP addresses as they appear in a socket or a forwarding header.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * A parsed IPv4 or IPv6 address. IPv4-mapped IPv6 becomes IPv4.
 */
final class Address {

	/**
	 * Internal ranges: private, loopback, link-local, carrier-grade NAT, unique
	 * local and unspecified, as hex prefix and length in bits.
	 */
	const INTERNAL_V4 = array(
		array( '0a000000', 8 ),
		array( 'ac100000', 12 ),
		array( 'c0a80000', 16 ),
		array( '7f000000', 8 ),
		array( 'a9fe0000', 16 ),
		array( '64400000', 10 ),
		array( '00000000', 8 ),
	);
	const INTERNAL_V6 = array(
		array( '00000000000000000000000000000001', 128 ),
		array( '00000000000000000000000000000000', 128 ),
		array( 'fe800000000000000000000000000000', 10 ),
		array( 'fc000000000000000000000000000000', 7 ),
	);

	/**
	 * Normal form: dotted quad, or RFC 5952 for IPv6.
	 *
	 * @var string
	 */
	public $text;

	/**
	 * The address bytes as lowercase hex (8 or 32 characters), for range matching.
	 *
	 * @var string
	 */
	public $hex;

	/**
	 * Either 'ipv4' or 'ipv6'.
	 *
	 * @var string
	 */
	public $family;

	/**
	 * True for private, loopback, link-local, carrier-grade NAT, unique local or unspecified.
	 *
	 * @var bool
	 */
	public $internal;

	/**
	 * Creates an address from its bytes.
	 *
	 * @param string $bytes 4 or 16 bytes.
	 */
	private function __construct( $bytes ) {
		$this->hex      = bin2hex( $bytes );
		$this->family   = 4 === strlen( $bytes ) ? 'ipv4' : 'ipv6';
		$this->text     = 'ipv4' === $this->family ? implode( '.', array_map( 'ord', str_split( $bytes ) ) ) : $this->rfc5952_v6();
		$ranges         = 'ipv4' === $this->family ? self::INTERNAL_V4 : self::INTERNAL_V6;
		$this->internal = false;
		foreach ( $ranges as $range ) {
			if ( self::in_prefix( $this->hex, $range[0], $range[1] ) ) {
				$this->internal = true;
				break;
			}
		}
	}

	/**
	 * Parses one address: strict dotted-quad IPv4, IPv6 with or without
	 * brackets, an optional port, and no zone id. Returns null for anything else.
	 *
	 * @param mixed $input Text.
	 * @return Address|null
	 */
	public static function parse( $input ) {
		if ( ! is_string( $input ) || '' === $input ) {
			return null;
		}
		$value = trim( $input );
		if ( preg_match( '/^\[([^\]]+)\](?::\d+)?$/', $value, $match ) ) {
			$value = $match[1];
		} elseif ( preg_match( '/^\d{1,3}(\.\d{1,3}){3}:\d+$/', $value ) ) {
			$value = substr( $value, 0, strrpos( $value, ':' ) );
		}
		if ( false !== strpos( $value, '%' ) ) {
			return null;
		}
		if ( preg_match( '/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/', $value ) ) {
			foreach ( explode( '.', $value ) as $part ) {
				if ( (int) $part > 255 || strlen( $part ) > 3 ) {
					return null;
				}
			}
			return new self( (string) inet_pton( $value ) );
		}
		if ( false !== strpos( $value, ':' ) && false !== filter_var( $value, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6 ) ) {
			$bytes = inet_pton( $value );
			if ( false === $bytes || 16 !== strlen( $bytes ) ) {
				return null;
			}
			// IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 address.
			if ( str_repeat( "\0", 10 ) . "\xff\xff" === substr( $bytes, 0, 12 ) ) {
				return new self( substr( $bytes, 12 ) );
			}
			return new self( $bytes );
		}
		return null;
	}

	/**
	 * True when hex is inside the prefix.
	 *
	 * @param string $hex    Address hex.
	 * @param string $prefix Prefix hex, same length.
	 * @param int    $bits   Prefix length.
	 * @return bool
	 */
	private static function in_prefix( $hex, $prefix, $bits ) {
		$bytes  = hex2bin( $hex );
		$pbytes = hex2bin( $prefix );
		$full   = intdiv( $bits, 8 );
		if ( substr( $bytes, 0, $full ) !== substr( $pbytes, 0, $full ) ) {
			return false;
		}
		$rest = $bits % 8;
		if ( 0 === $rest ) {
			return true;
		}
		$mask = ( 0xff << ( 8 - $rest ) ) & 0xff;
		return ( ord( $bytes[ $full ] ) & $mask ) === ( ord( $pbytes[ $full ] ) & $mask );
	}

	/**
	 * The RFC 5952 text of an IPv6 address: lowercase, no leading zeros, and
	 * the longest run of two or more zero groups (the first, on a tie) as "::".
	 *
	 * @return string
	 */
	public function rfc5952_v6() {
		$groups = array();
		for ( $i = 0; $i < 8; $i++ ) {
			$groups[] = ltrim( substr( $this->hex, $i * 4, 4 ), '0' );
		}
		$groups      = array_map(
			function ( $group ) {
				return '' === $group ? '0' : $group;
			},
			$groups
		);
		$best_start  = -1;
		$best_length = 0;
		$start       = -1;
		for ( $i = 0; $i <= 8; $i++ ) {
			if ( $i < 8 && '0' === $groups[ $i ] ) {
				if ( -1 === $start ) {
					$start = $i;
				}
				continue;
			}
			if ( -1 !== $start ) {
				$length = $i - $start;
				if ( $length > $best_length && $length >= 2 ) {
					$best_start  = $start;
					$best_length = $length;
				}
				$start = -1;
			}
		}
		if ( -1 === $best_start ) {
			return implode( ':', $groups );
		}
		$left  = implode( ':', array_slice( $groups, 0, $best_start ) );
		$right = implode( ':', array_slice( $groups, $best_start + $best_length ) );
		return $left . '::' . $right;
	}
}
