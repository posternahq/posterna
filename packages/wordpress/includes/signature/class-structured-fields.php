<?php
/**
 * Structured Field Values for HTTP (RFC 9651): parser and serializer.
 *
 * Only what HTTP Message Signatures and the Web Bot Auth drafts need:
 * dictionaries, items, inner lists and parameters. It follows the
 * structured-headers 2.0.3 package that Posterna's TypeScript core uses,
 * including where that package is lenient, so both ports read a header the
 * same way. Notes on the port: docs/REVIEW-NOTES.md.
 *
 * Representation:
 * - A bare item is an int, float, string, bool, Sf_Token, Sf_Bytes, Sf_Date or
 *   Sf_Display_String.
 * - Parameters are an ordered array of key => bare item.
 * - An item is array( bare item, parameters ).
 * - An inner list is array( list of items, parameters ).
 * - A dictionary is an ordered array of key => item or inner list.
 *
 * @package Posterna
 */

namespace Posterna\Signature;

defined( 'ABSPATH' ) || exit;

/**
 * Parses and serializes Structured Field Values.
 */
final class Structured_Fields {

	/**
	 * Input being parsed.
	 *
	 * @var string
	 */
	private $input;

	/**
	 * Read position in bytes.
	 *
	 * @var int
	 */
	private $pos = 0;

	/**
	 * Starts a parser.
	 *
	 * @param string $input Header value.
	 */
	private function __construct( $input ) {
		$this->input = (string) $input;
	}

	/**
	 * Parses a dictionary.
	 *
	 * @param string $input Header value.
	 * @return array Ordered key => member.
	 * @throws Sf_Error When the value is not a dictionary.
	 */
	public static function parse_dictionary( $input ) {
		$parser = new self( $input );
		return $parser->dictionary();
	}

	/**
	 * Parses a single item.
	 *
	 * @param string $input Header value.
	 * @return array array( bare item, parameters ).
	 * @throws Sf_Error When the value is not an item.
	 */
	public static function parse_item( $input ) {
		$parser = new self( $input );
		return $parser->item( true );
	}

	/**
	 * True when a dictionary member is an inner list rather than an item.
	 *
	 * @param array $member Member.
	 * @return bool
	 */
	public static function is_inner_list( $member ) {
		return is_array( $member ) && isset( $member[0] ) && is_array( $member[0] );
	}

	/**
	 * Parses a dictionary at the current position.
	 *
	 * @return array
	 * @throws Sf_Error When the input is malformed.
	 */
	private function dictionary() {
		$this->skip_sp();
		$dictionary = array();
		while ( ! $this->eof() ) {
			$key = $this->key();
			if ( '=' === $this->look() ) {
				++$this->pos;
				$member = $this->item_or_inner_list();
			} else {
				$member = array( true, $this->parameters() );
			}
			$dictionary[ $key ] = $member;
			$this->skip_ows();
			if ( $this->eof() ) {
				return $dictionary;
			}
			$this->expect( ',' );
			++$this->pos;
			$this->skip_ows();
			if ( $this->eof() ) {
				$exception = new Sf_Error( 'Dictionary contained a trailing comma' );
				throw $exception;
			}
		}
		return $dictionary;
	}

	/**
	 * Parses an item.
	 *
	 * @param bool $standalone True when the item is the whole header.
	 * @return array
	 * @throws Sf_Error When the input is malformed.
	 */
	private function item( $standalone ) {
		if ( $standalone ) {
			$this->skip_sp();
		}
		$result = array( $this->bare_item(), $this->parameters() );
		if ( $standalone ) {
			$this->skip_sp();
			if ( ! $this->eof() ) {
				$exception = new Sf_Error( 'Unexpected characters at end of input' );
				throw $exception;
			}
		}
		return $result;
	}

	/**
	 * Parses an item or an inner list.
	 *
	 * @return array
	 * @throws Sf_Error When the input is malformed.
	 */
	private function item_or_inner_list() {
		if ( '(' === $this->look() ) {
			return $this->inner_list();
		}
		return $this->item( false );
	}

	/**
	 * Parses an inner list.
	 *
	 * @return array
	 * @throws Sf_Error When the input is malformed.
	 */
	private function inner_list() {
		$this->expect( '(' );
		++$this->pos;
		$items = array();
		while ( ! $this->eof() ) {
			$this->skip_sp();
			if ( ')' === $this->look() ) {
				++$this->pos;
				return array( $items, $this->parameters() );
			}
			$items[] = $this->item( false );
			$next    = $this->look();
			if ( ' ' !== $next && ')' !== $next ) {
				$exception = new Sf_Error( 'Expected a space or ) after every item in an inner list' );
				throw $exception;
			}
		}
		$exception = new Sf_Error( 'Could not find end of inner list' );
		throw $exception;
	}

	/**
	 * Parses a bare item.
	 *
	 * @return mixed
	 * @throws Sf_Error When the input is malformed.
	 */
	private function bare_item() {
		$char = $this->look();
		if ( null === $char ) {
			$exception = new Sf_Error( 'Unexpected end of string' );
			throw $exception;
		}
		if ( '-' === $char || self::is_digit( $char ) ) {
			return $this->number();
		}
		if ( '"' === $char ) {
			return $this->string();
		}
		if ( '*' === $char || 1 === preg_match( '/^[A-Za-z]$/', $char ) ) {
			return $this->token();
		}
		if ( ':' === $char ) {
			return $this->bytes();
		}
		if ( '?' === $char ) {
			return $this->boolean();
		}
		if ( '@' === $char ) {
			return $this->date();
		}
		if ( '%' === $char ) {
			return $this->display_string();
		}
		$exception = new Sf_Error( 'Unexpected input' );
		throw $exception;
	}

	/**
	 * Parses parameters.
	 *
	 * @return array
	 * @throws Sf_Error When the input is malformed.
	 */
	private function parameters() {
		$parameters = array();
		while ( ! $this->eof() ) {
			if ( ';' !== $this->look() ) {
				break;
			}
			++$this->pos;
			$this->skip_sp();
			$key   = $this->key();
			$value = true;
			if ( '=' === $this->look() ) {
				++$this->pos;
				$value = $this->bare_item();
			}
			$parameters[ $key ] = $value;
		}
		return $parameters;
	}

	/**
	 * Parses an integer or a decimal.
	 *
	 * @return int|float
	 * @throws Sf_Error When the input is malformed.
	 */
	private function number() {
		$type   = 'integer';
		$sign   = 1;
		$digits = '';
		if ( '-' === $this->look() ) {
			$sign = -1;
			++$this->pos;
		}
		$first = $this->look();
		if ( ! self::is_digit( $first ) ) {
			$exception = new Sf_Error( 'Expected a digit' );
			throw $exception;
		}
		while ( ! $this->eof() ) {
			$char = $this->input[ $this->pos ];
			++$this->pos;
			if ( self::is_digit( $char ) ) {
				$digits .= $char;
			} elseif ( 'integer' === $type && '.' === $char ) {
				if ( strlen( $digits ) > 12 ) {
					$exception = new Sf_Error( 'Exceeded maximum decimal length' );
					throw $exception;
				}
				$digits .= '.';
				$type    = 'decimal';
			} else {
				--$this->pos;
				break;
			}
			if ( 'integer' === $type && strlen( $digits ) > 15 ) {
				$exception = new Sf_Error( 'Exceeded maximum integer length' );
				throw $exception;
			}
			if ( 'decimal' === $type && strlen( $digits ) > 16 ) {
				$exception = new Sf_Error( 'Exceeded maximum decimal length' );
				throw $exception;
			}
		}
		if ( 'integer' === $type ) {
			return $sign * (int) $digits;
		}
		if ( '.' === substr( $digits, -1 ) ) {
			$exception = new Sf_Error( 'Decimal cannot end on a period' );
			throw $exception;
		}
		$parts = explode( '.', $digits );
		if ( strlen( $parts[1] ) > 3 ) {
			$exception = new Sf_Error( 'Too many digits after the decimal point' );
			throw $exception;
		}
		return $sign * (float) $digits;
	}

	/**
	 * Parses a string.
	 *
	 * @return string
	 * @throws Sf_Error When the input is malformed.
	 */
	private function string() {
		$this->expect( '"' );
		++$this->pos;
		$output = '';
		while ( ! $this->eof() ) {
			$char = $this->input[ $this->pos ];
			++$this->pos;
			if ( '\\' === $char ) {
				if ( $this->eof() ) {
					$exception = new Sf_Error( 'Unexpected end of input' );
					throw $exception;
				}
				$next = $this->input[ $this->pos ];
				++$this->pos;
				if ( '\\' !== $next && '"' !== $next ) {
					$exception = new Sf_Error( 'A backslash must be followed by a backslash or a double quote' );
					throw $exception;
				}
				$output .= $next;
			} elseif ( '"' === $char ) {
				return $output;
			} elseif ( ord( $char ) < 0x20 || ord( $char ) > 0x7e ) {
				$exception = new Sf_Error( 'Strings must be printable ASCII' );
				throw $exception;
			} else {
				$output .= $char;
			}
		}
		$exception = new Sf_Error( 'Unexpected end of input' );
		throw $exception;
	}

	/**
	 * Parses a display string.
	 *
	 * @return Sf_Display_String
	 * @throws Sf_Error When the input is malformed.
	 */
	private function display_string() {
		if ( '%"' !== substr( $this->input, $this->pos, 2 ) ) {
			$exception = new Sf_Error( 'Display strings start with %"' );
			throw $exception;
		}
		$this->pos += 2;
		$bytes      = '';
		while ( ! $this->eof() ) {
			$char = $this->input[ $this->pos ];
			++$this->pos;
			$code = ord( $char );
			if ( $code <= 0x1f || $code >= 0x7f ) {
				$exception = new Sf_Error( 'Invalid character in a display string' );
				throw $exception;
			}
			if ( '%' === $char ) {
				$hex        = substr( $this->input, $this->pos, 2 );
				$this->pos += 2;
				if ( ! preg_match( '/^[0-9a-f]{2}$/', $hex ) ) {
					$exception = new Sf_Error( 'Invalid percent sequence in a display string' );
					throw $exception;
				}
				$bytes .= chr( hexdec( $hex ) );
				continue;
			}
			if ( '"' === $char ) {
				if ( ! preg_match( '//u', $bytes ) ) {
					$exception = new Sf_Error( 'Display string is not UTF-8' );
					throw $exception;
				}
				return new Sf_Display_String( $bytes );
			}
			$bytes .= $char;
		}
		$exception = new Sf_Error( 'Unexpected end of input' );
		throw $exception;
	}

	/**
	 * Parses a token.
	 *
	 * @return Sf_Token
	 * @throws Sf_Error When the input is malformed.
	 */
	private function token() {
		$length = strspn( $this->input, ":/!#$%&'*+-.^_`|~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", $this->pos );
		$value  = substr( $this->input, $this->pos, $length );

		$this->pos += $length;
		return new Sf_Token( $value );
	}

	/**
	 * Parses a byte sequence. Like the browser's atob(), padding may be left
	 * out, but if present it must complete the last group.
	 *
	 * @return Sf_Bytes
	 * @throws Sf_Error When the input is malformed.
	 */
	private function bytes() {
		$this->expect( ':' );
		++$this->pos;
		$end = strpos( $this->input, ':', $this->pos );
		if ( false === $end ) {
			$exception = new Sf_Error( 'Could not find the end of a byte sequence' );
			throw $exception;
		}
		$content   = substr( $this->input, $this->pos, $end - $this->pos );
		$this->pos = $end + 1;
		$decoded   = self::decode_base64( $content );
		if ( null === $decoded ) {
			$exception = new Sf_Error( 'Byte sequence is not valid base64' );
			throw $exception;
		}
		return new Sf_Bytes( $decoded );
	}

	/**
	 * Decodes base64 as the browser's atob() does, or returns null.
	 *
	 * @param string $content Base64 text.
	 * @return string|null
	 */
	public static function decode_base64( $content ) {
		if ( ! preg_match( '/^[A-Za-z0-9+\/=]*$/', $content ) ) {
			return null;
		}
		if ( 0 === strlen( $content ) % 4 ) {
			if ( '==' === substr( $content, -2 ) ) {
				$content = substr( $content, 0, -2 );
			} elseif ( '=' === substr( $content, -1 ) ) {
				$content = substr( $content, 0, -1 );
			}
		}
		if ( 1 === strlen( $content ) % 4 || false !== strpos( $content, '=' ) ) {
			return null;
		}
		// Plain decoding of base64 that was checked above; this is not obfuscation.
		$decoded = base64_decode( str_pad( $content, (int) ( ceil( strlen( $content ) / 4 ) * 4 ), '=' ), true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		return false === $decoded ? null : $decoded;
	}

	/**
	 * Parses a boolean.
	 *
	 * @return bool
	 * @throws Sf_Error When the input is malformed.
	 */
	private function boolean() {
		$this->expect( '?' );
		++$this->pos;
		$char = $this->look();
		++$this->pos;
		if ( '1' === $char ) {
			return true;
		}
		if ( '0' === $char ) {
			return false;
		}
		$exception = new Sf_Error( 'Expected ?1 or ?0' );
		throw $exception;
	}

	/**
	 * Parses a date. Like structured-headers 2.0.3, a date must end the input.
	 *
	 * @return Sf_Date
	 * @throws Sf_Error When the input is malformed.
	 */
	private function date() {
		$this->expect( '@' );
		++$this->pos;
		$sign = 1;
		if ( '-' === $this->look() ) {
			$sign = -1;
			++$this->pos;
		}
		$first = $this->look();
		if ( ! self::is_digit( $first ) ) {
			$exception = new Sf_Error( 'Expected a digit' );
			throw $exception;
		}
		$digits = '';
		while ( ! $this->eof() ) {
			$char = $this->input[ $this->pos ];
			++$this->pos;
			if ( ! self::is_digit( $char ) ) {
				$exception = new Sf_Error( 'Expected a digit or the end of input' );
				throw $exception;
			}
			$digits .= $char;
		}
		if ( strlen( $digits ) > 15 ) {
			$exception = new Sf_Error( 'Date is too long' );
			throw $exception;
		}
		return new Sf_Date( $sign * (int) $digits );
	}

	/**
	 * Parses a key.
	 *
	 * @return string
	 * @throws Sf_Error When the input is malformed.
	 */
	private function key() {
		$first = $this->look();
		if ( null === $first || ! preg_match( '/^[a-z*]$/', $first ) ) {
			$exception = new Sf_Error( 'A key must begin with a lowercase letter or *' );
			throw $exception;
		}
		$length = strspn( $this->input, 'abcdefghijklmnopqrstuvwxyz0123456789_-.*', $this->pos );
		$key    = substr( $this->input, $this->pos, $length );

		$this->pos += $length;
		return $key;
	}

	/**
	 * True for one ASCII digit, whatever the locale.
	 *
	 * @param string|null $char Character.
	 * @return bool
	 */
	private static function is_digit( $char ) {
		return null !== $char && 1 === strlen( $char ) && $char >= '0' && $char <= '9';
	}

	/**
	 * The next character, or null at the end.
	 *
	 * @return string|null
	 */
	private function look() {
		return $this->pos < strlen( $this->input ) ? $this->input[ $this->pos ] : null;
	}

	/**
	 * Fails unless the next character is the one given.
	 *
	 * @param string $char Expected character.
	 * @throws Sf_Error When it is not.
	 */
	private function expect( $char ) {
		if ( $this->look() !== $char ) {
			$exception = new Sf_Error( 'Expected ' . $char );
			throw $exception;
		}
	}

	/**
	 * True at the end of input.
	 *
	 * @return bool
	 */
	private function eof() {
		return $this->pos >= strlen( $this->input );
	}

	/**
	 * Skips spaces and tabs.
	 */
	private function skip_ows() {
		$this->pos += strspn( $this->input, " \t", $this->pos );
	}

	/**
	 * Skips spaces.
	 */
	private function skip_sp() {
		$this->pos += strspn( $this->input, ' ', $this->pos );
	}

	/**
	 * Serializes a bare item.
	 *
	 * @param mixed $value Bare item.
	 * @return string
	 * @throws Sf_Error When the value cannot be serialized.
	 */
	public static function serialize_bare_item( $value ) {
		if ( is_int( $value ) || ( is_float( $value ) && is_finite( $value ) && floor( $value ) === $value ) ) {
			// Like JavaScript, a decimal with no fraction is written as an integer.
			if ( $value < -999999999999999 || $value > 999999999999999 ) {
				$exception = new Sf_Error( 'Integer out of range' );
				throw $exception;
			}
			return (string) (int) $value;
		}
		if ( is_float( $value ) ) {
			$out = rtrim( number_format( $value, 3, '.', '' ), '0' );
			if ( strlen( str_replace( '-', '', explode( '.', $out )[0] ) ) > 12 ) {
				$exception = new Sf_Error( 'Decimal out of range' );
				throw $exception;
			}
			return $out;
		}
		if ( is_string( $value ) ) {
			if ( ! preg_match( '/^[\x20-\x7e]*$/', $value ) ) {
				$exception = new Sf_Error( 'Only ASCII strings may be serialized' );
				throw $exception;
			}
			return '"' . addcslashes( $value, '"\\' ) . '"';
		}
		if ( $value instanceof Sf_Token ) {
			return $value->value;
		}
		if ( $value instanceof Sf_Bytes ) {
			return ':' . base64_encode( $value->bytes ) . ':'; // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- Serializing a byte sequence (RFC 9651).
		}
		if ( $value instanceof Sf_Display_String ) {
			$out    = '%"';
			$length = strlen( $value->text );
			for ( $i = 0; $i < $length; $i++ ) {
				$code = ord( $value->text[ $i ] );
				$out .= ( 0x25 === $code || 0x22 === $code || $code <= 0x1f || $code >= 0x7f ) ? '%' . dechex( $code ) : $value->text[ $i ];
			}
			return $out . '"';
		}
		if ( $value instanceof Sf_Date ) {
			return '@' . $value->seconds;
		}
		if ( is_bool( $value ) ) {
			return $value ? '?1' : '?0';
		}
		$exception = new Sf_Error( 'Cannot serialize this value' );
		throw $exception;
	}

	/**
	 * Serializes a key.
	 *
	 * @param string $key Key.
	 * @return string
	 * @throws Sf_Error When the key is invalid.
	 */
	public static function serialize_key( $key ) {
		if ( ! preg_match( '/^[a-z*][*\-_.a-z0-9]*$/', (string) $key ) ) {
			$exception = new Sf_Error( 'Invalid key' );
			throw $exception;
		}
		return (string) $key;
	}

	/**
	 * Serializes parameters.
	 *
	 * @param array $parameters Ordered key => bare item.
	 * @return string
	 * @throws Sf_Error When a value cannot be serialized.
	 */
	public static function serialize_parameters( $parameters ) {
		$out = '';
		foreach ( $parameters as $key => $value ) {
			$out .= ';' . self::serialize_key( $key );
			if ( true !== $value ) {
				$out .= '=' . self::serialize_bare_item( $value );
			}
		}
		return $out;
	}

	/**
	 * Serializes an item.
	 *
	 * @param mixed $value      Bare item.
	 * @param array $parameters Parameters.
	 * @return string
	 * @throws Sf_Error When a value cannot be serialized.
	 */
	public static function serialize_item( $value, $parameters = array() ) {
		return self::serialize_bare_item( $value ) . self::serialize_parameters( $parameters );
	}

	/**
	 * Serializes an inner list.
	 *
	 * @param array $inner_list array( items, parameters ).
	 * @return string
	 * @throws Sf_Error When a value cannot be serialized.
	 */
	public static function serialize_inner_list( $inner_list ) {
		$items = array();
		foreach ( $inner_list[0] as $item ) {
			$items[] = self::serialize_item( $item[0], $item[1] );
		}
		return '(' . implode( ' ', $items ) . ')' . self::serialize_parameters( $inner_list[1] );
	}
}
