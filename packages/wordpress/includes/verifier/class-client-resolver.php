<?php
/**
 * Client address, signed host and scheme (docs/SPEC.md section 4.2).
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * A port of packages/core/src/verifier/client.ts. Forwarding headers are read
 * only when the socket peer is a trusted proxy; the client is the rightmost
 * address that is not a trusted proxy.
 */
final class Client_Resolver {

	/**
	 * One header the host's proxy overwrites with the client address, lowercase, or null.
	 *
	 * @var string|null
	 */
	private $client_ip_header;

	/**
	 * Trusted proxy CIDRs, or null.
	 *
	 * @var Prefix_Matcher|null
	 */
	private $cidrs;

	/**
	 * Trusted hop count, or 0.
	 *
	 * @var int
	 */
	private $hops;

	/**
	 * Either 'x-forwarded-for' or 'forwarded'.
	 *
	 * @var string
	 */
	private $header;

	/**
	 * Hostnames agents sign, lowercase.
	 *
	 * @var array
	 */
	private $public_hosts;

	/**
	 * Take the host from X-Forwarded-Host when a trusted proxy sent the request.
	 *
	 * @var bool
	 */
	private $trust_forwarded_host;

	/**
	 * Compiles the proxy options.
	 *
	 * @param array $options Keys as in core: clientIpHeader, trustedProxies (list of CIDRs or a
	 *                       hop count), forwardedHeader, publicHost (string or list), trustForwardedHost.
	 */
	public function __construct( $options ) {
		$header                     = isset( $options['clientIpHeader'] ) && is_string( $options['clientIpHeader'] ) ? strtolower( trim( $options['clientIpHeader'] ) ) : '';
		$this->client_ip_header     = '' === $header ? null : $header;
		$proxies                    = isset( $options['trustedProxies'] ) ? $options['trustedProxies'] : null;
		$this->cidrs                = is_array( $proxies ) ? Prefix_Matcher::compile( $proxies ) : null;
		$this->hops                 = ( is_int( $proxies ) && $proxies > 0 ) ? $proxies : 0;
		$this->header               = ( isset( $options['forwardedHeader'] ) && 'forwarded' === $options['forwardedHeader'] ) ? 'forwarded' : 'x-forwarded-for';
		$hosts                      = isset( $options['publicHost'] ) ? $options['publicHost'] : array();
		$hosts                      = is_string( $hosts ) ? array( $hosts ) : (array) $hosts;
		$this->public_hosts         = array_values(
			array_filter(
				array_map(
					function ( $host ) {
						return strtolower( trim( (string) $host ) );
					},
					$hosts
				),
				'strlen'
			)
		);
		$this->trust_forwarded_host = ! empty( $options['trustForwardedHost'] );
	}

	/**
	 * Forwarding entries, oldest first, from X-Forwarded-For or the for= parameters of Forwarded.
	 *
	 * @param Request $request Request.
	 * @return array
	 */
	private function chain( $request ) {
		$raw = $request->value( $this->header );
		if ( null === $raw || '' === $raw ) {
			return array();
		}
		if ( 'x-forwarded-for' === $this->header ) {
			return array_values(
				array_filter(
					array_map( 'trim', explode( ',', $raw ) ),
					'strlen'
				)
			);
		}
		$chain = array();
		foreach ( self::split_outside_quotes( $raw, ',' ) as $element ) {
			$for = null;
			foreach ( self::split_outside_quotes( $element, ';' ) as $pair ) {
				$pair = trim( $pair );
				if ( 0 === strpos( strtolower( $pair ), 'for=' ) ) {
					$for = $pair;
					break;
				}
			}
			// An element without for= is still a hop; record it as unknown so it cannot be skipped.
			$chain[] = null === $for ? 'unknown' : preg_replace( '/^"(.*)"$/', '$1', trim( substr( $for, 4 ) ) );
		}
		return $chain;
	}

	/**
	 * Splits on a separator outside double quotes.
	 *
	 * @param string $value     Text.
	 * @param string $separator Separator.
	 * @return array
	 */
	private static function split_outside_quotes( $value, $separator ) {
		$parts   = array();
		$current = '';
		$quoted  = false;
		$length  = strlen( $value );
		for ( $i = 0; $i < $length; $i++ ) {
			$char = $value[ $i ];
			if ( '"' === $char && ( 0 === $i || '\\' !== $value[ $i - 1 ] ) ) {
				$quoted = ! $quoted;
			}
			if ( $char === $separator && ! $quoted ) {
				$parts[] = $current;
				$current = '';
			} else {
				$current .= $char;
			}
		}
		$parts[] = $current;
		return $parts;
	}

	/**
	 * The last comma-separated value, trimmed, or null.
	 *
	 * @param string|null $raw Header value.
	 * @return string|null
	 */
	private static function last_value( $raw ) {
		if ( null === $raw ) {
			return null;
		}
		$parts = explode( ',', $raw );
		$value = trim( (string) end( $parts ) );
		return '' === $value ? null : $value;
	}

	/**
	 * Works out the client address, the signed host and the scheme.
	 *
	 * @param Request $request Request.
	 * @return array array( 'address' => ?Address, 'address_source', 'client_ip_header', 'host',
	 *               'host_source', 'scheme', 'via_trusted_proxy' ).
	 */
	public function resolve( $request ) {
		$socket           = Address::parse( $request->remote_address );
		$address          = $socket;
		$address_source   = null === $socket ? 'none' : 'socket';
		$via_trusted      = false;
		$client_ip_header = null;

		if ( null !== $this->client_ip_header && ( null === $socket || null === $this->cidrs || $this->cidrs->has( $socket ) ) ) {
			// One header the host overwrites: no hop counting. Repeated or
			// comma-separated values mean something appended to it; the rightmost
			// is the nearest proxy's.
			$via_trusted      = true;
			$client_ip_header = $this->client_ip_header;
			$picked           = Address::parse( self::last_value( $request->value( $this->client_ip_header ) ) );
			$address          = $picked;
			$address_source   = null === $picked ? $this->client_ip_header . ' header (missing or unreadable)' : $this->client_ip_header . ' header';
		} elseif ( null !== $this->client_ip_header ) {
			// Configured, but this request did not come from a listed proxy: the
			// socket address is the client, as without configuration.
			$address_source = null === $socket ? 'none' : 'socket';
		} elseif ( null !== $socket && null !== $this->cidrs && $this->cidrs->has( $socket ) ) {
			$via_trusted = true;
			$chain       = $this->chain( $request );
			for ( $i = count( $chain ) - 1; $i >= 0; $i-- ) {
				$hop = Address::parse( $chain[ $i ] );
				if ( null === $hop ) {
					// An unreadable hop ends the walk: the last trusted address is all we know.
					$address_source = $this->header . ' (unreadable entry; using the nearest trusted hop)';
					break;
				}
				$address        = $hop;
				$address_source = $this->header . ' entry ' . ( count( $chain ) - $i ) . ' from the right';
				if ( ! $this->cidrs->has( $hop ) ) {
					break;
				}
			}
		} elseif ( null === $socket && ( null !== $this->cidrs || $this->hops > 0 ) ) {
			// No socket address: the configured proxies are trusted to have written
			// the forwarding header, so read it from its right end.
			$via_trusted = true;
			$chain       = $this->chain( $request );
			if ( null !== $this->cidrs ) {
				for ( $i = count( $chain ) - 1; $i >= 0; $i-- ) {
					$hop = Address::parse( $chain[ $i ] );
					if ( null === $hop ) {
						$address_source = $this->header . ' (unreadable entry)';
						break;
					}
					$address        = $hop;
					$address_source = $this->header . ' entry ' . ( count( $chain ) - $i ) . ' from the right (no socket address)';
					if ( ! $this->cidrs->has( $hop ) ) {
						break;
					}
				}
			} else {
				// Fewer entries than hops: take the leftmost, as with a socket address.
				$index  = max( 0, count( $chain ) - $this->hops );
				$picked = array() === $chain ? null : Address::parse( $chain[ $index ] );
				if ( null !== $picked ) {
					$address        = $picked;
					$address_source = $this->header . ' with ' . $this->hops . ' trusted hops (no socket address)';
				} else {
					$address_source = $this->header . ' (too few or unreadable entries)';
				}
			}
		} elseif ( null !== $socket && $this->hops > 0 ) {
			$via_trusted = true;
			$chain       = $this->chain( $request );
			$chain[]     = $socket->text;
			$index       = max( 0, count( $chain ) - 1 - $this->hops );
			$picked      = Address::parse( $chain[ $index ] );
			if ( null !== $picked ) {
				$address        = $picked;
				$address_source = count( $chain ) - 1 === $index ? 'socket' : $this->header . ' with ' . $this->hops . ' trusted hops';
			} else {
				$address_source = $this->header . ' (unreadable entry; using the socket)';
			}
		}

		$forwarded_host = ( $via_trusted && $this->trust_forwarded_host ) ? self::last_value( $request->value( 'x-forwarded-host' ) ) : null;
		if ( null !== $forwarded_host ) {
			$host        = strtolower( $forwarded_host );
			$host_source = 'x-forwarded-host';
		} else {
			$raw_host    = $request->value( 'host' );
			$raw_host    = null === $raw_host ? $request->url_host : $raw_host;
			$host        = null === $raw_host ? null : strtolower( $raw_host );
			$host_source = null === $host ? 'none' : 'host';
		}
		if ( array() !== $this->public_hosts ) {
			if ( null === $host || ! in_array( $host, $this->public_hosts, true ) ) {
				$host = $this->public_hosts[0];
			}
			$host_source = 'publicHost';
		}

		$scheme = null === $request->url_scheme ? 'https' : $request->url_scheme;
		if ( array() !== $this->public_hosts ) {
			$scheme = 'https';
		} elseif ( $via_trusted ) {
			$proto = self::last_value( $request->value( 'x-forwarded-proto' ) );
			$proto = null === $proto ? null : strtolower( $proto );
			if ( 'http' === $proto || 'https' === $proto ) {
				$scheme = $proto;
			}
		}

		return array(
			'address'           => $address,
			'address_source'    => $address_source,
			'client_ip_header'  => $client_ip_header,
			'host'              => $host,
			'host_source'       => $host_source,
			'scheme'            => $scheme,
			'via_trusted_proxy' => $via_trusted,
		);
	}
}
