<?php
/**
 * Who a request says it is (docs/SPEC.md section 4.3). Nothing here is verified yet.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

use Posterna\Signature\Web_Bot_Auth;

defined( 'ABSPATH' ) || exit;

/**
 * A port of packages/core/src/verifier/claim.ts.
 */
final class Claim {

	/**
	 * Identifies the claim.
	 *
	 * @param Request         $request Request.
	 * @param Directory_Index $index   Directory.
	 * @return array array( 'signature_operators' => slugs, 'signature_agent_present' => bool,
	 *               'signed' => bool, 'user_agent' => array( slug, position )|null ).
	 */
	public static function identify( $request, $index ) {
		$header    = $request->value( 'signature-agent' );
		$operators = array();
		if ( null !== $header ) {
			$operators = self::signature_agent_operators( $header, $index );
		}
		return array(
			'signature_operators'     => $operators,
			'signature_agent_present' => null !== $header,
			'signed'                  => null !== $request->value( 'signature' ) && null !== $request->value( 'signature-input' ),
			'user_agent'              => self::match_user_agent( $request->value( 'user-agent' ), $index ),
		);
	}

	/**
	 * The listed operators a Signature-Agent header names, in header order.
	 * Only directory-type members with an https origin count; nothing is fetched.
	 *
	 * @param string          $header Header value.
	 * @param Directory_Index $index  Directory.
	 * @return array Slugs.
	 */
	public static function signature_agent_operators( $header, $index ) {
		try {
			$parsed = Web_Bot_Auth::parse_signature_agent( $header );
		} catch ( \Exception $error ) {
			return array();
		}
		$operators = array();
		foreach ( $parsed['entries'] as $entry ) {
			// Only the directory type is supported; other types are ignored, as the draft requires.
			if ( 'directory' !== $entry['type'] ) {
				continue;
			}
			$origin = Url::signature_agent_origin( $entry['uri'] );
			$slug   = null === $origin ? null : $index->signing_origin( $origin );
			if ( null !== $slug && ! in_array( $slug, $operators, true ) ) {
				$operators[] = $slug;
			}
		}
		return $operators;
	}

	/**
	 * The agent a User-Agent names: exact tokens first, then phrases;
	 * researched agents before community ones.
	 *
	 * @param string|null     $user_agent User-Agent.
	 * @param Directory_Index $index      Directory.
	 * @return array|null array( slug, position ).
	 */
	public static function match_user_agent( $user_agent, $index ) {
		if ( null === $user_agent || '' === $user_agent ) {
			return null;
		}
		$community = null;
		$best      = null;
		$length    = 0;
		if ( preg_match_all( '/[A-Za-z0-9][A-Za-z0-9._-]*/', $user_agent, $words ) ) {
			foreach ( $words[0] as $word ) {
				$lower = strtolower( $word );
				$ref   = $index->token( $lower );
				if ( null === $ref ) {
					$ref = $index->token( preg_replace( '/[._-]+$/', '', $lower ) );
				}
				if ( null === $ref ) {
					continue;
				}
				if ( 'researched' === $ref[2] ) {
					if ( null === $best || strlen( $word ) > $length ) {
						$best   = array( $ref[0], $ref[1] );
						$length = strlen( $word );
					}
				} elseif ( null === $community ) {
					$community = array( $ref[0], $ref[1] );
				}
			}
		}
		if ( null !== $best ) {
			return $best;
		}
		foreach ( $index->phrases() as $phrase ) {
			if ( ! preg_match( $phrase[0], $user_agent ) ) {
				continue;
			}
			$operator = $index->operator( $phrase[1] );
			$coverage = $operator['agents'][ $phrase[2] ]['coverage'];
			if ( 'researched' === $coverage ) {
				return array( $phrase[1], $phrase[2] );
			}
			if ( null === $community ) {
				$community = array( $phrase[1], $phrase[2] );
			}
		}
		return $community;
	}
}
