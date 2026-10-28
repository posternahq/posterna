<?php
/**
 * HTTP Message Signatures (RFC 9421) verification for requests.
 *
 * A port of the parts of Cloudflare's http-message-sig 0.3.0 that Posterna's
 * TypeScript core uses: the same checks, in the same order, with the same
 * error codes, so a request gets the same verdict and reason in both ports.
 * Only request signatures are supported, and only the components that
 * library supports. Notes on the port: docs/REVIEW-NOTES.md.
 *
 * A message is array( 'method' => string, 'target_uri' => string,
 * 'fields' => list of array( 'name' => string, 'value' => string ) ).
 *
 * @package Posterna
 */

namespace Posterna\Signature;

use Posterna\Verifier\Url;

defined( 'ABSPATH' ) || exit;

/**
 * Verifies one RFC 9421 signature on a request.
 */
final class Message_Signature {

	const FIELD_NAME = '/^[!#$%&\'*+.^_`|~0-9A-Za-z-]+$/';
	const SF_KEY     = '/^[a-z*][a-z0-9_.*-]*$/';
	const DERIVED    = array( '@method', '@target-uri', '@authority', '@scheme', '@request-target', '@path', '@query', '@status' );

	/**
	 * Throws a signature error.
	 *
	 * @param string          $code    Error code.
	 * @param string          $message Message.
	 * @param \Throwable|null $cause   Cause.
	 * @throws Signature_Error Always.
	 */
	private static function fail( $code, $message, $cause = null ) {
		$exception = new Signature_Error( $code, $message, $cause );
		throw $exception;
	}

	/**
	 * Verifies the signature with the given label (or the only one).
	 *
	 * @param array $message Request descriptor.
	 * @param array $options array( 'label' => ?string, 'policy' => array( 'algorithms', 'required_components',
	 *                       'required_parameters', 'max_age', 'clock_skew', 'now', 'validate' ),
	 *                       'resolve_verifier' => callable( array $candidate ): array ).
	 * @return array The verified signature.
	 * @throws Signature_Error When the signature is malformed, unsupported or invalid.
	 */
	public static function verify( $message, $options ) {
		$snapshot  = self::snapshot( $message );
		$signature = self::field( $snapshot, 'signature' );
		$input     = self::field( $snapshot, 'signature-input' );
		$sigs      = self::parse_signature_dictionary( $signature );
		$inputs    = self::parse_signature_input_dictionary( $input );
		$label     = self::selected_label( $sigs, $inputs, isset( $options['label'] ) ? $options['label'] : null );
		$member    = isset( $inputs[ $label ] ) ? $inputs[ $label ] : null;
		$sig       = isset( $sigs[ $label ] ) ? $sigs[ $label ] : null;
		if ( null === $member || ! Structured_Fields::is_inner_list( $member ) || null === $sig ) {
			self::fail( Signature_Error::LABEL_MISMATCH, 'Incomplete signature ' . $label );
		}
		$parsed = self::parsed_signature_input( $member );
		$bytes  = self::signature_bytes( $sig );
		$base   = self::signature_base( $snapshot, $parsed['components'], $member );
		$policy = $options['policy'];
		$now    = $policy['now'];
		if ( ! is_int( $now ) && ! ( is_float( $now ) && is_finite( $now ) ) ) {
			self::fail( Signature_Error::POLICY_VIOLATION, 'now must be finite' );
		}
		self::assert_policy( $parsed['components'], $parsed['parameters'], $policy, $now );
		$claimed = isset( $parsed['parameters']['alg'] ) ? $parsed['parameters']['alg'] : null;
		if ( null !== $claimed && ! in_array( $claimed, $policy['algorithms'], true ) ) {
			self::fail( Signature_Error::POLICY_VIOLATION, 'Algorithm ' . $claimed . ' is not allowed' );
		}
		$candidate = array(
			'label'      => $label,
			'algorithm'  => $claimed,
			'components' => $parsed['components'],
			'parameters' => $parsed['parameters'],
			'signature'  => $bytes,
		);
		try {
			$verifier = call_user_func( $options['resolve_verifier'], $candidate );
		} catch ( \Throwable $error ) {
			self::fail( Signature_Error::RESOLVER_FAILED, 'Verifier resolution failed', $error );
		}
		if ( ! in_array( $verifier['algorithm'], $policy['algorithms'], true ) ) {
			self::fail( Signature_Error::POLICY_VIOLATION, 'Algorithm ' . $verifier['algorithm'] . ' is not allowed' );
		}
		if ( null !== $claimed && $claimed !== $verifier['algorithm'] ) {
			self::fail( Signature_Error::ALGORITHM_MISMATCH, 'Claimed algorithm ' . $claimed . ' does not match ' . $verifier['algorithm'] );
		}
		if ( true !== call_user_func( $verifier['verify'], $base, $bytes ) ) {
			self::fail( Signature_Error::VERIFICATION_FAILED, 'Signature verification failed' );
		}
		$verified = array(
			'verifier'   => $verifier,
			'label'      => $label,
			'algorithm'  => $verifier['algorithm'],
			'components' => $parsed['components'],
			'parameters' => $parsed['parameters'],
			'signature'  => $bytes,
		);
		if ( isset( $policy['validate'] ) && false === call_user_func( $policy['validate'], $verified ) ) {
			self::fail( Signature_Error::POLICY_VIOLATION, 'Signature rejected by policy' );
		}
		return $verified;
	}

	/**
	 * Checks and copies a request descriptor.
	 *
	 * @param array $message Request descriptor.
	 * @return array
	 * @throws Signature_Error When it is not valid.
	 */
	private static function snapshot( $message ) {
		if ( ! is_string( $message['method'] ) || ! preg_match( self::FIELD_NAME, $message['method'] ) ) {
			self::fail( Signature_Error::INVALID_COMPONENT, 'Invalid request method' );
		}
		self::assert_ascii( $message['target_uri'], 'Target URI' );
		$fields = array();
		foreach ( $message['fields'] as $field ) {
			if ( ! preg_match( self::FIELD_NAME, $field['name'] ) ) {
				self::fail( Signature_Error::MALFORMED_FIELD, 'Invalid field name ' . $field['name'] );
			}
			$value = self::normalize_value( $field['value'] );
			self::assert_ascii( $value, 'Field ' . $field['name'] );
			$fields[] = array(
				'name'  => strtolower( $field['name'] ),
				'value' => $value,
			);
		}
		return array(
			'method'     => $message['method'],
			'target_uri' => $message['target_uri'],
			'fields'     => $fields,
		);
	}

	/**
	 * Folds obsolete line folding and trims spaces and tabs.
	 *
	 * @param string $value Field value.
	 * @return string
	 */
	private static function normalize_value( $value ) {
		$value = preg_replace( '/\r\n[\t ]+/', ' ', (string) $value );
		return preg_replace( '/^[\t ]+|[\t ]+$/', '', $value );
	}

	/**
	 * Fails unless every character is visible ASCII, a space or a tab.
	 *
	 * @param string $value    Text.
	 * @param string $location For the message.
	 * @throws Signature_Error When it is not.
	 */
	private static function assert_ascii( $value, $location ) {
		if ( ! is_string( $value ) || preg_match( '/[^\x20-\x7e\t]/', $value ) ) {
			self::fail( Signature_Error::MALFORMED_FIELD, $location . ' is not ASCII field content' );
		}
	}

	/**
	 * A field's values joined with ", ".
	 *
	 * @param array  $snapshot Request snapshot.
	 * @param string $name     Lowercase field name.
	 * @return string
	 * @throws Signature_Error When the field is missing.
	 */
	private static function field( $snapshot, $name ) {
		$values = array();
		foreach ( $snapshot['fields'] as $field ) {
			if ( strtolower( $field['name'] ) === $name ) {
				$values[] = self::normalize_value( $field['value'] );
			}
		}
		if ( array() === $values ) {
			self::fail( Signature_Error::MISSING_FIELD, 'Missing field ' . $name );
		}
		return implode( ', ', $values );
	}

	/**
	 * Fails when a header uses RFC 9651 dates or display strings.
	 *
	 * @param string $input Header value.
	 * @param string $name  For the message.
	 * @throws Signature_Error When it does.
	 */
	private static function assert_no_rfc9651( $input, $name ) {
		$quoted  = false;
		$escaped = false;
		$length  = strlen( $input );
		for ( $i = 0; $i < $length; $i++ ) {
			$char = $input[ $i ];
			if ( $escaped ) {
				$escaped = false;
				continue;
			}
			if ( $quoted && '\\' === $char ) {
				$escaped = true;
				continue;
			}
			if ( '"' === $char ) {
				$quoted = ! $quoted;
				continue;
			}
			if ( ! $quoted && ( '@' === $char || ( '%' === $char && $i + 1 < $length && '"' === $input[ $i + 1 ] ) ) ) {
				self::fail( Signature_Error::UNSUPPORTED_FEATURE, $name . ' uses an RFC 9651-only value' );
			}
		}
	}

	/**
	 * Fails when a value is an RFC 9651-only type.
	 *
	 * @param mixed  $value    Bare item.
	 * @param string $location For the message.
	 * @return mixed The value.
	 * @throws Signature_Error When it is.
	 */
	private static function rfc8941_bare_item( $value, $location ) {
		if ( $value instanceof Sf_Date || $value instanceof Sf_Display_String ) {
			self::fail( Signature_Error::UNSUPPORTED_FEATURE, $location . ' uses an RFC 9651-only value' );
		}
		return $value;
	}

	/**
	 * Parses an RFC 8941 dictionary.
	 *
	 * @param string $input Header value.
	 * @param string $name  For the message.
	 * @return array
	 * @throws Signature_Error When it is malformed or uses RFC 9651 types.
	 */
	public static function parse_rfc8941_dictionary( $input, $name ) {
		self::assert_no_rfc9651( $input, $name );
		try {
			$dictionary = Structured_Fields::parse_dictionary( $input );
		} catch ( Sf_Error $error ) {
			self::fail( Signature_Error::MALFORMED_FIELD, 'Malformed ' . $name, $error );
		}
		foreach ( $dictionary as $member ) {
			if ( Structured_Fields::is_inner_list( $member ) ) {
				foreach ( $member[0] as $item ) {
					self::rfc8941_bare_item( $item[0], $name );
					foreach ( $item[1] as $parameter ) {
						self::rfc8941_bare_item( $parameter, $name );
					}
				}
			} else {
				self::rfc8941_bare_item( $member[0], $name );
			}
			foreach ( $member[1] as $parameter ) {
				self::rfc8941_bare_item( $parameter, $name );
			}
		}
		return $dictionary;
	}

	/**
	 * Parses a dictionary and refuses duplicate labels and parameters.
	 *
	 * @param string $input Header value.
	 * @param string $name  For the message.
	 * @return array
	 * @throws Signature_Error When it is malformed.
	 */
	private static function parse_strict_dictionary( $input, $name ) {
		$dictionary = self::parse_rfc8941_dictionary( $input, $name );
		if ( self::top_level_member_count( $input ) !== count( $dictionary ) ) {
			self::fail( Signature_Error::DUPLICATE_LABEL, $name . ' has duplicate labels' );
		}
		$parsed = 0;
		foreach ( $dictionary as $member ) {
			$parsed += count( $member[1] );
			if ( Structured_Fields::is_inner_list( $member ) ) {
				foreach ( $member[0] as $item ) {
					$parsed += count( $item[1] );
				}
			}
		}
		if ( self::raw_parameter_count( $input ) !== $parsed ) {
			self::fail( Signature_Error::MALFORMED_FIELD, $name . ' has duplicate parameters' );
		}
		return $dictionary;
	}

	/**
	 * Counts top-level dictionary members in raw text.
	 *
	 * @param string $input Header value.
	 * @return int
	 */
	private static function top_level_member_count( $input ) {
		$count   = '' === trim( $input ) ? 0 : 1;
		$depth   = 0;
		$quoted  = false;
		$escaped = false;
		$length  = strlen( $input );
		for ( $i = 0; $i < $length; $i++ ) {
			$char = $input[ $i ];
			if ( $escaped ) {
				$escaped = false;
				continue;
			}
			if ( $quoted && '\\' === $char ) {
				$escaped = true;
				continue;
			}
			if ( '"' === $char ) {
				$quoted = ! $quoted;
			}
			if ( $quoted ) {
				continue;
			}
			if ( '(' === $char ) {
				++$depth;
			}
			if ( ')' === $char ) {
				--$depth;
			}
			if ( ',' === $char && 0 === $depth ) {
				++$count;
			}
		}
		return $count;
	}

	/**
	 * Counts parameters in raw text.
	 *
	 * @param string $input Header value.
	 * @return int
	 */
	private static function raw_parameter_count( $input ) {
		$count   = 0;
		$quoted  = false;
		$escaped = false;
		$length  = strlen( $input );
		for ( $i = 0; $i < $length; $i++ ) {
			$char = $input[ $i ];
			if ( $escaped ) {
				$escaped = false;
				continue;
			}
			if ( $quoted && '\\' === $char ) {
				$escaped = true;
				continue;
			}
			if ( '"' === $char ) {
				$quoted = ! $quoted;
			}
			if ( ! $quoted && ';' === $char ) {
				++$count;
			}
		}
		return $count;
	}

	/**
	 * Parses the Signature field.
	 *
	 * @param string $input Header value.
	 * @return array
	 * @throws Signature_Error When it is malformed.
	 */
	private static function parse_signature_dictionary( $input ) {
		$dictionary = self::parse_strict_dictionary( $input, 'Signature' );
		foreach ( $dictionary as $member ) {
			if ( Structured_Fields::is_inner_list( $member ) || ! ( $member[0] instanceof Sf_Bytes ) || array() !== $member[1] ) {
				self::fail( Signature_Error::MALFORMED_FIELD, 'Signature members must be unparameterized byte sequences' );
			}
		}
		return $dictionary;
	}

	/**
	 * Parses the Signature-Input field.
	 *
	 * @param string $input Header value.
	 * @return array
	 * @throws Signature_Error When it is malformed.
	 */
	private static function parse_signature_input_dictionary( $input ) {
		$dictionary = self::parse_strict_dictionary( $input, 'Signature-Input' );
		foreach ( $dictionary as $member ) {
			if ( ! Structured_Fields::is_inner_list( $member ) ) {
				self::fail( Signature_Error::MALFORMED_FIELD, 'Signature-Input members must be inner lists' );
			}
		}
		return $dictionary;
	}

	/**
	 * Picks the label to verify.
	 *
	 * @param array       $signatures Signature dictionary.
	 * @param array       $inputs     Signature-Input dictionary.
	 * @param string|null $requested  Requested label.
	 * @return string
	 * @throws Signature_Error When the labels do not line up.
	 */
	private static function selected_label( $signatures, $inputs, $requested ) {
		$keys = array_map( 'strval', array_keys( $signatures ) );
		$ins  = array_map( 'strval', array_keys( $inputs ) );
		sort( $keys );
		sort( $ins );
		if ( $keys !== $ins ) {
			self::fail( Signature_Error::LABEL_MISMATCH, 'Signature and Signature-Input label sets differ' );
		}
		if ( null !== $requested ) {
			if ( ! array_key_exists( $requested, $signatures ) || ! array_key_exists( $requested, $inputs ) ) {
				self::fail( Signature_Error::LABEL_MISMATCH, 'Label ' . $requested . ' is not present in both signature fields' );
			}
			return $requested;
		}
		if ( 1 !== count( $signatures ) ) {
			self::fail( Signature_Error::LABEL_REQUIRED, 'An explicit label is required for multiple or mismatched signatures' );
		}
		return (string) array_key_first( $signatures );
	}

	/**
	 * Reads the covered components and parameters of one Signature-Input member.
	 *
	 * @param array $member Inner list.
	 * @return array array( 'components' => list, 'parameters' => array ).
	 * @throws Signature_Error When it is malformed or unsupported.
	 */
	private static function parsed_signature_input( $member ) {
		$components = array();
		foreach ( $member[0] as $item ) {
			$name = $item[0];
			if ( ! is_string( $name ) ) {
				self::fail( Signature_Error::MALFORMED_FIELD, 'Component identifiers must be strings' );
			}
			if ( strtolower( $name ) !== $name ) {
				self::fail( Signature_Error::MALFORMED_FIELD, 'Component identifier ' . $name . ' must be lowercase' );
			}
			$parameters = array();
			foreach ( $item[1] as $key => $value ) {
				$parameters[ $key ] = self::rfc8941_bare_item( $value, 'Component parameter ' . $key );
			}
			$components[] = self::component( $name, $parameters );
		}
		$identities = array();
		foreach ( $components as $component ) {
			$identity = self::equivalent_identity( $component );
			if ( isset( $identities[ $identity ] ) ) {
				self::fail( Signature_Error::DUPLICATE_COMPONENT, 'Duplicate component ' . $identity );
			}
			$identities[ $identity ] = true;
		}
		$parameters = array();
		foreach ( $member[1] as $key => $value ) {
			$parameters[ $key ] = self::rfc8941_bare_item( $value, 'Parameter ' . $key );
		}
		self::validate_known_parameters( $parameters );
		return array(
			'components' => $components,
			'parameters' => $parameters,
		);
	}

	/**
	 * True for an integer, or a decimal with no fraction (JavaScript's Number.isInteger).
	 *
	 * @param mixed $value Value.
	 * @return bool
	 */
	public static function is_integer( $value ) {
		return is_int( $value ) || ( is_float( $value ) && is_finite( $value ) && floor( $value ) === $value );
	}

	/**
	 * Checks the types of the parameters RFC 9421 defines.
	 *
	 * @param array $parameters Signature parameters.
	 * @throws Signature_Error When one has the wrong type.
	 */
	private static function validate_known_parameters( $parameters ) {
		foreach ( array( 'created', 'expires' ) as $name ) {
			if ( array_key_exists( $name, $parameters ) && ! self::is_integer( $parameters[ $name ] ) ) {
				self::fail( Signature_Error::MALFORMED_FIELD, $name . ' must be an integer' );
			}
		}
		foreach ( array( 'nonce', 'alg', 'keyid', 'tag' ) as $name ) {
			if ( array_key_exists( $name, $parameters ) && ! is_string( $parameters[ $name ] ) ) {
				self::fail( Signature_Error::MALFORMED_FIELD, $name . ' must be a string' );
			}
		}
	}

	/**
	 * Validates a component identifier.
	 *
	 * @param string $name       Component name.
	 * @param array  $parameters Component parameters.
	 * @return array array( 'name' => string, 'parameters' => array ).
	 * @throws Signature_Error When it is invalid or unsupported.
	 */
	public static function component( $name, $parameters = array() ) {
		$name = strtolower( $name );
		if ( '@' === substr( $name, 0, 1 ) ) {
			if ( '@query-param' === $name ) {
				self::fail( Signature_Error::UNSUPPORTED_FEATURE, '@query-param is not supported' );
			}
			if ( ! in_array( $name, self::DERIVED, true ) ) {
				self::fail( Signature_Error::UNSUPPORTED_FEATURE, 'Unknown derived component ' . $name );
			}
		} elseif ( ! preg_match( self::FIELD_NAME, $name ) ) {
			self::fail( Signature_Error::INVALID_COMPONENT, 'Invalid field component ' . $name );
		}
		foreach ( $parameters as $key => $value ) {
			if ( ! preg_match( self::SF_KEY, (string) $key ) ) {
				self::fail( Signature_Error::MALFORMED_FIELD, 'Invalid parameter name ' . $key );
			}
			try {
				Structured_Fields::serialize_bare_item( $value );
			} catch ( Sf_Error $error ) {
				self::fail( Signature_Error::MALFORMED_FIELD, 'Invalid component parameter ' . $key, $error );
			}
		}
		foreach ( $parameters as $key => $value ) {
			if ( in_array( $key, array( 'sf', 'bs', 'tr' ), true ) ) {
				self::fail( Signature_Error::UNSUPPORTED_FEATURE, $key . ' is not supported' );
			}
			if ( 'req' !== $key && 'key' !== $key ) {
				self::fail( Signature_Error::UNSUPPORTED_FEATURE, 'Component parameter ' . $key . ' is not supported' );
			}
			if ( 'req' === $key && true !== $value ) {
				self::fail( Signature_Error::INVALID_COMPONENT, 'req must be true' );
			}
			if ( 'key' === $key && ! is_string( $value ) ) {
				self::fail( Signature_Error::INVALID_COMPONENT, 'key must be a string' );
			}
		}
		if ( '@' === substr( $name, 0, 1 ) && array_key_exists( 'key', $parameters ) ) {
			self::fail( Signature_Error::INVALID_COMPONENT, 'key is invalid on derived component ' . $name );
		}
		return array(
			'name'       => $name,
			'parameters' => $parameters,
		);
	}

	/**
	 * A component's identity with its parameters sorted, for duplicate checks.
	 *
	 * @param array $component Component.
	 * @return string
	 */
	public static function equivalent_identity( $component ) {
		$parameters = $component['parameters'];
		ksort( $parameters, SORT_STRING );
		return Structured_Fields::serialize_item( $component['name'], $parameters );
	}

	/**
	 * The signature bytes of a Signature member.
	 *
	 * @param array $member Member.
	 * @return string
	 */
	private static function signature_bytes( $member ) {
		return $member[0]->bytes;
	}

	/**
	 * Builds the signature base (RFC 9421 section 2.5).
	 *
	 * @param array $snapshot   Request snapshot.
	 * @param array $components Covered components.
	 * @param array $input      The Signature-Input member as parsed.
	 * @return string
	 * @throws Signature_Error When a component cannot be read.
	 */
	private static function signature_base( $snapshot, $components, $input ) {
		$lines = array();
		foreach ( $components as $component ) {
			$lines[] = Structured_Fields::serialize_item( $component['name'], $component['parameters'] ) . ': ' . self::component_value( $snapshot, $component );
		}
		$lines[] = '"@signature-params": ' . Structured_Fields::serialize_inner_list( $input );
		return implode( "\n", $lines );
	}

	/**
	 * The value of one covered component.
	 *
	 * @param array $snapshot  Request snapshot.
	 * @param array $component Component.
	 * @return string
	 * @throws Signature_Error When it cannot be read.
	 */
	private static function component_value( $snapshot, $component ) {
		if ( array_key_exists( 'req', $component['parameters'] ) ) {
			self::fail( Signature_Error::INVALID_COMPONENT, 'req requires a response with a related request' );
		}
		$name = $component['name'];
		if ( '@' === substr( $name, 0, 1 ) ) {
			return self::derived( $snapshot, $name );
		}
		$value = self::field( $snapshot, $name );
		if ( ! array_key_exists( 'key', $component['parameters'] ) ) {
			return $value;
		}
		$key        = $component['parameters']['key'];
		$dictionary = self::parse_rfc8941_dictionary( $value, 'field ' . $name );
		if ( ! array_key_exists( $key, $dictionary ) ) {
			self::fail( Signature_Error::MISSING_FIELD, 'Field ' . $name . ' has no dictionary member ' . $key );
		}
		$member = $dictionary[ $key ];
		return Structured_Fields::is_inner_list( $member )
			? Structured_Fields::serialize_inner_list( $member )
			: Structured_Fields::serialize_item( $member[0], $member[1] );
	}

	/**
	 * The value of a derived component.
	 *
	 * @param array  $snapshot Request snapshot.
	 * @param string $name     Component name.
	 * @return string
	 * @throws Signature_Error When it cannot be read.
	 */
	private static function derived( $snapshot, $name ) {
		if ( '@status' === $name ) {
			self::fail( Signature_Error::INVALID_COMPONENT, '@status requires a response' );
		}
		if ( '@method' === $name ) {
			return $snapshot['method'];
		}
		$uri = $snapshot['target_uri'];
		$url = Url::parse( $uri );
		if ( null === $url ) {
			self::fail( Signature_Error::INVALID_COMPONENT, $name . ' requires an absolute target URI' );
		}
		if ( '' !== $url['hash'] ) {
			self::fail( Signature_Error::INVALID_COMPONENT, $name . ' target URI cannot contain a fragment' );
		}
		$scheme_end = strpos( $uri, '://' );
		if ( false === $scheme_end ) {
			self::fail( Signature_Error::INVALID_COMPONENT, $name . ' requires an HTTP target URI' );
		}
		$path_start  = strpos( $uri, '/', $scheme_end + 3 );
		$query_start = strpos( $uri, '?', $scheme_end + 3 );
		$start       = ( false !== $path_start && ( false === $query_start || $path_start < $query_start ) ) ? $path_start : $query_start;
		$path_end    = false === $query_start ? strlen( $uri ) : $query_start;
		switch ( $name ) {
			case '@target-uri':
				return $uri;
			case '@authority':
				return $url['host'];
			case '@scheme':
				return $url['scheme'];
			case '@request-target':
				self::fail( Signature_Error::UNSUPPORTED_FEATURE, '@request-target requires a descriptor requestTarget' );
				break;
			case '@path':
				return ( false === $start || $start === $query_start ) ? '/' : substr( $uri, $start, $path_end - $start );
			case '@query':
				return false === $query_start ? '?' : substr( $uri, $query_start );
		}
		self::fail( Signature_Error::UNSUPPORTED_FEATURE, 'Unknown derived component ' . $name );
	}

	/**
	 * Applies the verification policy (RFC 9421 section 3.2).
	 *
	 * @param array     $components Covered components.
	 * @param array     $parameters Signature parameters.
	 * @param array     $policy     Policy.
	 * @param int|float $now        Seconds since the epoch.
	 * @throws Signature_Error When the policy is not met.
	 */
	private static function assert_policy( $components, $parameters, $policy, $now ) {
		$present = array();
		foreach ( $components as $component ) {
			$present[ self::equivalent_identity( $component ) ] = true;
		}
		foreach ( isset( $policy['required_components'] ) ? $policy['required_components'] : array() as $required ) {
			$identity = self::equivalent_identity( self::component( $required ) );
			if ( ! isset( $present[ $identity ] ) ) {
				self::fail( Signature_Error::POLICY_VIOLATION, 'Required component ' . $identity . ' is absent' );
			}
		}
		foreach ( isset( $policy['required_parameters'] ) ? $policy['required_parameters'] : array() as $required ) {
			if ( ! array_key_exists( $required, $parameters ) ) {
				self::fail( Signature_Error::POLICY_VIOLATION, 'Required parameter ' . $required . ' is absent' );
			}
		}
		$skew = isset( $policy['clock_skew'] ) ? $policy['clock_skew'] : 0;
		if ( ! is_numeric( $skew ) || $skew < 0 ) {
			self::fail( Signature_Error::POLICY_VIOLATION, 'clockSkew must be non-negative' );
		}
		$created = array_key_exists( 'created', $parameters ) ? $parameters['created'] : null;
		$expires = array_key_exists( 'expires', $parameters ) ? $parameters['expires'] : null;
		if ( null !== $created && $created > $now + $skew ) {
			self::fail( Signature_Error::POLICY_VIOLATION, 'Signature was created in the future' );
		}
		if ( null !== $expires && $expires < $now - $skew ) {
			self::fail( Signature_Error::POLICY_VIOLATION, 'Signature has expired' );
		}
		if ( isset( $policy['max_age'] ) ) {
			if ( ! is_numeric( $policy['max_age'] ) || $policy['max_age'] < 0 ) {
				self::fail( Signature_Error::POLICY_VIOLATION, 'maxAge must be non-negative' );
			}
			if ( null === $created ) {
				self::fail( Signature_Error::POLICY_VIOLATION, 'maxAge requires created' );
			}
			if ( $now - $created > $policy['max_age'] + $skew ) {
				self::fail( Signature_Error::POLICY_VIOLATION, 'Signature is too old' );
			}
		}
	}
}
