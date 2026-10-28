<?php
/**
 * Suggested robots.txt lines and Content Signals from a policy.
 *
 * @package Posterna
 */

namespace Posterna\Policy;

defined( 'ABSPATH' ) || exit;

/**
 * A port of packages/core/src/policy/emit.ts (docs/SPEC.md section 5.6). The
 * plugin only prints the text for an administrator to copy; it never changes
 * robots.txt.
 */
final class Robots {

	const SIGNALS = array(
		array( 'ai-train', 'training' ),
		array( 'search', 'search' ),
		array( 'ai-input', 'user_fetch' ),
	);

	const SECTION_TITLES = array(
		'training'   => 'Training',
		'search'     => 'Search',
		'user_fetch' => 'User-initiated fetches',
		'agent'      => 'Agents',
		'preview'    => 'Link previews',
		'ads'        => 'Ads',
		'other'      => 'Other',
	);

	/**
	 * The header core's CLI writes. The plugin passes its own.
	 */
	const CORE_HEADER = array(
		'# robots.txt written by Posterna from agents.yaml.',
		'# Crawlers that honor robots.txt are asked to stay out of what the policy blocks.',
		"# The site's policy engine enforces against agents that do not.",
	);

	/**
	 * A policy path pattern as a robots.txt path (RFC 9309).
	 *
	 * @param string $pattern Pattern.
	 * @return string
	 */
	public static function robots_path( $pattern ) {
		if ( false === strpos( $pattern, '*' ) ) {
			return $pattern . '$';
		}
		$path = preg_replace( '/\*+$/', '', $pattern );
		return '' === $path ? '/' : $path;
	}

	/**
	 * Content-Signal lines, without the User-agent line they belong under.
	 *
	 * @param array $policy Normalized policy.
	 * @return array
	 */
	public static function content_signal_lines( $policy ) {
		$line  = function ( $rules, $prefix ) {
			$values = array();
			foreach ( self::SIGNALS as $signal ) {
				if ( isset( $rules[ $signal[1] ] ) ) {
					$values[] = $signal[0] . '=' . ( 'block' === $rules[ $signal[1] ]['action'] ? 'no' : 'yes' );
				}
			}
			return array() === $values ? array() : array( 'Content-Signal: ' . $prefix . implode( ', ', $values ) );
		};
		$lines = $line( $policy['purposes'], '' );
		foreach ( $policy['paths'] as $rule ) {
			$lines = array_merge( $lines, $line( $rule['rules'], self::robots_path( $rule['pattern'] ) . ' ' ) );
		}
		return $lines;
	}

	/**
	 * Path rules, most specific first (docs/policy.md).
	 *
	 * @param array $paths Path rules in file order.
	 * @return array
	 */
	private static function by_specificity( $paths ) {
		$compiled = array();
		foreach ( $paths as $order => $rule ) {
			$parts      = explode( '*', $rule['pattern'] );
			$compiled[] = array(
				'rule'      => $rule,
				'exact'     => 1 === count( $parts ),
				'literals'  => strlen( $rule['pattern'] ) - ( count( $parts ) - 1 ),
				'wildcards' => count( $parts ) - 1,
				'order'     => $order,
			);
		}
		usort(
			$compiled,
			function ( $a, $b ) {
				if ( $a['exact'] !== $b['exact'] ) {
					return $a['exact'] ? -1 : 1;
				}
				if ( $a['literals'] !== $b['literals'] ) {
					return $b['literals'] - $a['literals'];
				}
				if ( $a['wildcards'] !== $b['wildcards'] ) {
					return $a['wildcards'] - $b['wildcards'];
				}
				return $a['order'] - $b['order'];
			}
		);
		return $compiled;
	}

	/**
	 * What the policy does with an agent when it is verified, as robots.txt lines.
	 *
	 * @param array  $policy Normalized policy.
	 * @param string $slug   Operator slug.
	 * @param array  $agent  Agent record.
	 * @return array
	 */
	private static function agent_lines( $policy, $slug, $agent ) {
		$purpose = $agent['purpose'];
		$base    = null;
		if ( isset( $policy['operators'][ $slug ][ $purpose ] ) ) {
			$base = $policy['operators'][ $slug ][ $purpose ];
		} elseif ( isset( $policy['purposes'][ $purpose ] ) ) {
			$base = $policy['purposes'][ $purpose ];
		} elseif ( isset( $policy['defaults']['verified'] ) ) {
			$base = $policy['defaults']['verified'];
		}
		$base_verb = ( null !== $base && 'block' === $base['action'] ) ? 'Disallow' : 'Allow';
		// Least specific first, so a nested rule is compared with what already covers it.
		$entries = array();
		foreach ( array_reverse( self::by_specificity( $policy['paths'] ) ) as $entry ) {
			$rules = $entry['rule']['rules'];
			$spec  = isset( $rules['verified'] ) ? $rules['verified'] : ( isset( $rules[ $purpose ] ) ? $rules[ $purpose ] : null );
			if ( null !== $spec ) {
				$entries[] = array(
					'path' => self::robots_path( $entry['rule']['pattern'] ),
					'verb' => 'block' === $spec['action'] ? 'Disallow' : 'Allow',
				);
			}
		}
		$lines = array();
		foreach ( $entries as $entry ) {
			if ( '/' === $entry['path'] ) {
				$base_verb = $entry['verb'];
				continue;
			}
			$covering = null;
			foreach ( $lines as $line ) {
				$prefix = preg_replace( '/\$$/', '', $line['path'] );
				if ( 0 === strpos( $entry['path'], $prefix ) && '$' !== substr( $line['path'], -1 ) ) {
					if ( null === $covering || strlen( $line['path'] ) > strlen( $covering['path'] ) ) {
						$covering = $line;
					}
				}
			}
			$current = null === $covering ? $base_verb : $covering['verb'];
			$exists  = false;
			foreach ( $lines as $line ) {
				if ( $line['path'] === $entry['path'] ) {
					$exists = true;
				}
			}
			// A rule that says what already covers it adds nothing.
			if ( $entry['verb'] !== $current && ! $exists ) {
				$lines[] = $entry;
			}
		}
		if ( 'Allow' === $base_verb && array() === $lines ) {
			return array();
		}
		usort(
			$lines,
			function ( $a, $b ) {
				return strcmp( $a['path'], $b['path'] );
			}
		);
		$out = 'Disallow' === $base_verb ? array( 'Disallow: /' ) : array();
		foreach ( $lines as $line ) {
			$out[] = $line['verb'] . ': ' . $line['path'];
		}
		return $out;
	}

	/**
	 * Writes robots.txt text from a policy and the operator directory.
	 *
	 * @param array $policy    Normalized policy.
	 * @param array $operators Slug => operator, in directory order, each with 'agents'.
	 * @param array $header    Comment lines to start with.
	 * @return string
	 */
	public static function emit( $policy, $operators, $header = self::CORE_HEADER ) {
		$robots  = in_array( 'robots.txt', $policy['emit'], true );
		$signals = in_array( 'content-signals', $policy['emit'], true ) ? self::content_signal_lines( $policy ) : array();
		$out     = $header;
		if ( array() !== $signals ) {
			$out[] = '# Content-Signal lines state how content may be used: https://contentsignals.org/';
		}
		if ( ! $robots && ! in_array( 'content-signals', $policy['emit'], true ) ) {
			$out[] = '# agents.yaml emits nothing. Add emit: [robots.txt, content-signals] to write rules here.';
		}
		$out[] = '';
		$out[] = 'User-agent: *';
		$out   = array_merge( $out, $signals );
		$out[] = 'Allow: /';

		if ( $robots ) {
			$seen = array();
			foreach ( Policy::PURPOSES as $purpose ) {
				$groups = array();
				foreach ( $operators as $slug => $operator ) {
					foreach ( $operator['agents'] as $agent ) {
						if ( $agent['purpose'] !== $purpose || 'honors' !== $agent['robots_policy'] || null === $agent['robots_token'] ) {
							continue;
						}
						if ( 'protect' === $policy['guards']['search_engines'] && $agent['search_engine'] ) {
							continue;
						}
						$token = $agent['robots_token'];
						if ( isset( $seen[ strtolower( $token ) ] ) ) {
							continue;
						}
						$lines = self::agent_lines( $policy, (string) $slug, $agent );
						if ( array() === $lines ) {
							continue;
						}
						$seen[ strtolower( $token ) ] = true;
						$key                          = implode( "\n", $lines );
						$groups[ $key ][]             = $token;
					}
				}
				if ( array() === $groups ) {
					continue;
				}
				$out[]   = '';
				$out[]   = '# ' . self::SECTION_TITLES[ $purpose ];
				$ordered = array();
				foreach ( $groups as $lines => $tokens ) {
					usort(
						$tokens,
						function ( $a, $b ) {
							return strcmp( strtolower( $a ), strtolower( $b ) );
						}
					);
					$ordered[] = array(
						'lines'  => (string) $lines,
						'tokens' => $tokens,
					);
				}
				usort(
					$ordered,
					function ( $a, $b ) {
						return strcmp( strtolower( $a['tokens'][0] ), strtolower( $b['tokens'][0] ) );
					}
				);
				foreach ( $ordered as $position => $group ) {
					if ( $position > 0 ) {
						$out[] = '';
					}
					foreach ( $group['tokens'] as $token ) {
						$out[] = 'User-agent: ' . $token;
					}
					$out[] = $group['lines'];
				}
			}
		}
		return implode( "\n", $out ) . "\n";
	}
}
