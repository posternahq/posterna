<?php
/**
 * The parts of a request the verifier reads.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * A request in one shape, whether it came from $_SERVER or from a test vector.
 * Inbound X-Agent-* and X-Posterna-* fields are dropped before anything can
 * read them (docs/SPEC.md section 4.7).
 */
final class Request {

	/**
	 * Uppercase method.
	 *
	 * @var string
	 */
	public $method = 'GET';

	/**
	 * Path and query, for example /docs?page=2.
	 *
	 * @var string
	 */
	public $target = '/';

	/**
	 * Header fields in arrival order: list of array( 'name' => lowercase, 'value' => string ).
	 *
	 * @var array
	 */
	public $fields = array();

	/**
	 * The TCP peer, when known.
	 *
	 * @var string|null
	 */
	public $remote_address = null;

	/**
	 * Scheme as the server saw it: 'http', 'https' or null.
	 *
	 * @var string|null
	 */
	public $url_scheme = null;

	/**
	 * Host from an absolute request target, or null.
	 *
	 * @var string|null
	 */
	public $url_host = null;

	/**
	 * Lowercase names of the inbound X-Agent-* and X-Posterna-* fields that were dropped.
	 *
	 * @var array
	 */
	public $stripped = array();

	/**
	 * True for a header name a client must never be able to set.
	 *
	 * @param string $name Header name.
	 * @return bool
	 */
	public static function is_inbound_verdict_header( $name ) {
		$lower = strtolower( (string) $name );
		return 0 === strpos( $lower, 'x-agent-' ) || 0 === strpos( $lower, 'x-posterna-' );
	}

	/**
	 * Builds a request from header pairs, keeping order and repeats.
	 *
	 * @param string      $method         Method.
	 * @param string      $target         Path and query, or an absolute URL.
	 * @param string|null $scheme         Scheme the server saw.
	 * @param string|null $remote_address TCP peer.
	 * @param array       $pairs          List of array( name, value ).
	 * @return Request
	 */
	public static function from_pairs( $method, $target, $scheme, $remote_address, $pairs ) {
		$request                 = new self();
		$request->method         = strtoupper( (string) $method );
		$request->remote_address = ( is_string( $remote_address ) && '' !== $remote_address ) ? $remote_address : null;
		$request->url_scheme     = $scheme;
		$request->apply_target( (string) $target );
		$stripped = array();
		foreach ( $pairs as $pair ) {
			$name = strtolower( (string) $pair[0] );
			if ( self::is_inbound_verdict_header( $name ) ) {
				$stripped[ $name ] = true;
				continue;
			}
			$request->fields[] = array(
				'name'  => $name,
				'value' => (string) $pair[1],
			);
		}
		$request->stripped = array_keys( $stripped );
		sort( $request->stripped );
		return $request;
	}

	/**
	 * Builds a request from $_SERVER. PHP joins repeated headers already.
	 *
	 * @param array $server The $_SERVER array, or a copy.
	 * @return Request
	 */
	public static function from_server( $server ) {
		$request         = new self();
		$request->method = isset( $server['REQUEST_METHOD'] ) && is_string( $server['REQUEST_METHOD'] ) ? strtoupper( $server['REQUEST_METHOD'] ) : 'GET';
		$remote          = isset( $server['REMOTE_ADDR'] ) && is_string( $server['REMOTE_ADDR'] ) ? $server['REMOTE_ADDR'] : '';

		$request->remote_address = '' === $remote ? null : $remote;
		$https                   = isset( $server['HTTPS'] ) && is_string( $server['HTTPS'] ) ? strtolower( $server['HTTPS'] ) : '';
		$port                    = isset( $server['SERVER_PORT'] ) ? (string) $server['SERVER_PORT'] : '';
		$request->url_scheme     = ( 'on' === $https || '1' === $https || '443' === $port ) ? 'https' : 'http';
		$request->apply_target( isset( $server['REQUEST_URI'] ) && is_string( $server['REQUEST_URI'] ) ? $server['REQUEST_URI'] : '/' );
		$stripped = array();
		foreach ( $server as $key => $value ) {
			if ( ! is_string( $key ) || ! is_string( $value ) ) {
				continue;
			}
			if ( 0 === strpos( $key, 'HTTP_' ) ) {
				$name = strtolower( str_replace( '_', '-', substr( $key, 5 ) ) );
			} elseif ( 'CONTENT_TYPE' === $key || 'CONTENT_LENGTH' === $key ) {
				$name = strtolower( str_replace( '_', '-', $key ) );
			} else {
				continue;
			}
			if ( self::is_inbound_verdict_header( $name ) ) {
				$stripped[ $name ] = true;
				continue;
			}
			$request->fields[] = array(
				'name'  => $name,
				'value' => $value,
			);
		}
		$request->stripped = array_keys( $stripped );
		sort( $request->stripped );
		return $request;
	}

	/**
	 * Reads the request target, splitting an absolute URL into its parts.
	 *
	 * @param string $raw Request target.
	 */
	private function apply_target( $raw ) {
		if ( preg_match( '#^https?://#i', $raw ) ) {
			$url = Url::parse( $raw );
			if ( null !== $url ) {
				$this->target     = $url['pathname'] . $url['search'];
				$this->url_scheme = $url['scheme'];
				$this->url_host   = $url['host'];
				return;
			}
		}
		$this->target = ( '' !== $raw && '/' === $raw[0] ) ? $raw : '/' . $raw;
	}

	/**
	 * All values of a field, in order.
	 *
	 * @param string $name Lowercase name.
	 * @return array
	 */
	public function values( $name ) {
		$values = array();
		foreach ( $this->fields as $field ) {
			if ( $field['name'] === $name ) {
				$values[] = $field['value'];
			}
		}
		return $values;
	}

	/**
	 * A field's values joined with ", " as HTTP combines repeated lines, or null.
	 *
	 * @param string $name Lowercase name.
	 * @return string|null
	 */
	public function value( $name ) {
		$values = $this->values( $name );
		return array() === $values ? null : implode( ', ', $values );
	}

	/**
	 * The path without the query.
	 *
	 * @return string
	 */
	public function path() {
		$query = strpos( $this->target, '?' );
		return false === $query ? $this->target : substr( $this->target, 0, $query );
	}
}
