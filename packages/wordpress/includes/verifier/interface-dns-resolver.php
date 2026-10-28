<?php
/**
 * The two lookups forward-confirmed reverse DNS needs.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * A DNS resolver. Both methods throw on a lookup error; an empty list means
 * the name or record does not exist.
 */
interface Dns_Resolver {

	/**
	 * PTR names for an address.
	 *
	 * @param string $ip Address in normal form.
	 * @return array
	 */
	public function reverse( $ip );

	/**
	 * A and AAAA addresses for a name.
	 *
	 * @param string $hostname Name.
	 * @return array
	 */
	public function forward( $hostname );
}
