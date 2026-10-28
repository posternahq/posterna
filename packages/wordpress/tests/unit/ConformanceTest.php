<?php
/**
 * Runs every vector in conformance/ against the PHP port.
 *
 * The format is in conformance/README.md. Verify vectors run twice: once
 * with header pairs (order and repeats kept) and once through a $_SERVER
 * array, as the plugin reads requests. Policy vectors (decide and
 * policy_check) are skipped: plugin 1.0 runs in monitor mode and has no
 * policy engine (docs/REVIEW-NOTES.md lists them).
 *
 * @package Posterna
 */

namespace Posterna\Tests;

use PHPUnit\Framework\TestCase;
use Posterna\Directory\Directory_Store;
use Posterna\Directory\Memory_Directory_Storage;
use Posterna\Policy\Policy;
use Posterna\Policy\Robots;
use Posterna\Signature\Message_Signature;
use Posterna\Signature\Signature_Library;
use Posterna\Signature\Signature_Path;
use Posterna\Signature\Web_Bot_Auth;
use Posterna\Verifier\Dns_Resolver;
use Posterna\Verifier\Index_Builder;
use Posterna\Verifier\Memory_Nonce_Store;
use Posterna\Verifier\Memory_Rdns_Store;
use Posterna\Verifier\Rdns_Cache;
use Posterna\Verifier\Request;
use Posterna\Verifier\Verifier;
use Symfony\Component\Yaml\Yaml;

/**
 * Conformance vectors.
 */
final class ConformanceTest extends TestCase {

	const BASE_URL = 'https://directory.fixtures.example/v1/';

	/**
	 * Path to conformance/.
	 *
	 * @return string
	 */
	private static function root() {
		return POSTERNA_TEST_REPO . '/conformance';
	}

	/**
	 * Reads a JSON file under conformance/.
	 *
	 * @param string $path Relative path.
	 * @return array
	 */
	private static function read( $path ) {
		return json_decode( file_get_contents( self::root() . '/' . $path ), true );
	}

	/**
	 * Every vector file, sorted.
	 *
	 * @return array
	 */
	private static function files() {
		$files    = array();
		$iterator = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( self::root() . '/vectors', \FilesystemIterator::SKIP_DOTS ) );
		foreach ( $iterator as $file ) {
			if ( '.json' === substr( $file->getFilename(), -5 ) ) {
				$files[] = $file->getPathname();
			}
		}
		sort( $files );
		return $files;
	}

	/**
	 * One case per vector and request API.
	 *
	 * @return array
	 */
	public static function vectors() {
		$cases = array();
		foreach ( self::files() as $path ) {
			$vector = json_decode( file_get_contents( $path ), true );
			$id     = substr( $path, strlen( self::root() . '/vectors/' ), -5 );
			if ( 'verify' === $vector['type'] ) {
				$cases[ $id . ' (pairs)' ]  = array( $id, $vector, 'pairs' );
				$cases[ $id . ' (server)' ] = array( $id, $vector, 'server' );
			} else {
				$cases[ $id ] = array( $id, $vector, '' );
			}
		}
		return $cases;
	}

	/**
	 * There are vectors to run.
	 */
	public function test_has_vectors() {
		$this->assertGreaterThan( 50, count( self::files() ) );
	}

	/**
	 * Runs one vector.
	 *
	 * @dataProvider vectors
	 *
	 * @param string $id     Vector id.
	 * @param array  $vector Vector.
	 * @param string $api    Request API for verify vectors.
	 */
	public function test_vector( $id, $vector, $api ) {
		$this->assertSame( $id, $vector['id'] );
		switch ( $vector['type'] ) {
			case 'verify':
				$this->run_verify( $vector, $api );
				break;
			case 'rfc9421':
				$this->assertSame( $vector['expected']['valid'], $this->run_rfc9421( $vector ), $id );
				break;
			case 'key_directory':
				$this->run_key_directory( $vector );
				break;
			case 'robots':
				$this->run_robots( $vector );
				break;
			default:
				$this->markTestSkipped( 'Plugin 1.0 has no policy engine (monitor only): ' . $vector['type'] . ' vectors are listed in docs/REVIEW-NOTES.md.' );
		}
	}

	/**
	 * Builds a request for one step.
	 *
	 * @param array  $spec Request spec.
	 * @param string $api  'pairs' or 'server'.
	 * @return Request
	 */
	private static function build_request( $spec, $api ) {
		if ( 'pairs' === $api ) {
			return Request::from_pairs( $spec['method'], $spec['path'], $spec['scheme'], $spec['remote_address'], $spec['headers'] );
		}
		return Request::from_server( self::server_array( $spec ) );
	}

	/**
	 * The $_SERVER array PHP would give for a request spec.
	 *
	 * @param array $spec Request spec.
	 * @return array
	 */
	public static function server_array( $spec ) {
		$server = array(
			'REQUEST_METHOD' => $spec['method'],
			'REQUEST_URI'    => $spec['path'],
		);
		if ( 'https' === $spec['scheme'] ) {
			$server['HTTPS'] = 'on';
		}
		if ( null !== $spec['remote_address'] ) {
			$server['REMOTE_ADDR'] = $spec['remote_address'];
		}
		foreach ( $spec['headers'] as $pair ) {
			$name = strtoupper( str_replace( '-', '_', $pair[0] ) );
			$key  = in_array( $name, array( 'CONTENT_TYPE', 'CONTENT_LENGTH' ), true ) ? $name : 'HTTP_' . $name;
			// PHP joins repeated header lines with ", ".
			$server[ $key ] = isset( $server[ $key ] ) ? $server[ $key ] . ', ' . $pair[1] : $pair[1];
		}
		return $server;
	}

	/**
	 * Runs a verify vector.
	 *
	 * @param array  $vector Vector.
	 * @param string $api    Request API.
	 */
	private function run_verify( $vector, $api ) {
		$fetches  = array();
		$served   = isset( $vector['refresh']['responses'] ) ? $vector['refresh']['responses'] : array();
		$inject   = isset( $vector['inject'] ) ? $vector['inject'] : array();
		$refresh  = ! empty( $vector['refresh']['enabled'] );
		$now_ms   = strtotime( $vector['now'] ) * 1000;
		$clock    = ( isset( $inject['clock'] ) && 'invalid' === $inject['clock'] ) ? function () {
			return NAN;
		} : function () use ( $now_ms ) {
			return $now_ms;
		};
		$fixtures = array(
			'directory' => self::read( 'fixtures/directory.json' ),
			'keys'      => self::read( 'fixtures/keys.json' ),
		);
		$snapshot = function () use ( $inject, $fixtures ) {
			if ( isset( $inject['snapshot'] ) && 'missing' === $inject['snapshot'] ) {
				throw new \RuntimeException( 'ENOENT: the bundled snapshot is missing' );
			}
			if ( isset( $inject['snapshot'] ) && 'malformed' === $inject['snapshot'] ) {
				return array(
					'directory' => array(
						'schema'    => 1,
						'operators' => 'not a list',
					),
					'keys'      => null,
				);
			}
			return $fixtures;
		};
		$keys_pending = false;
		$store        = new Directory_Store(
			new Memory_Directory_Storage(),
			array(
				'snapshot'        => $snapshot,
				'refresh'         => $refresh,
				'base_url'        => self::BASE_URL,
				'trusted_keys'    => $refresh ? self::read( 'fixtures/directory-signers.json' )['keys'] : array(),
				'now'             => $clock,
				'fetch'           => function ( $url ) use ( &$fetches, &$served ) {
					$fetches[] = $url;
					$name      = substr( $url, strlen( self::BASE_URL ) );
					return isset( $served[ $name ] ) ? $served[ $name ] : array(
						'status' => 404,
						'body'   => '',
					);
				},
				'on_keys_refresh' => function () use ( &$keys_pending ) {
					$keys_pending = true;
				},
			)
		);
		$store->load();
		$resolver = null;
		if ( ! array_key_exists( 'dns', $vector ) || null !== $vector['dns'] ) {
			$answers  = isset( $vector['dns'] ) ? $vector['dns'] : array(
				'reverse' => array(),
				'forward' => array(),
			);
			$failure  = isset( $inject['dns'] ) ? $inject['dns'] : null;
			$timeout  = isset( $vector['config']['reverseDns']['timeoutMs'] ) ? $vector['config']['reverseDns']['timeoutMs'] : 1000;
			$resolver = new Fake_Dns( $answers, $failure, $timeout );
		}
		$config  = isset( $vector['config'] ) ? $vector['config'] : array();
		$rdns    = new Rdns_Cache( $resolver, isset( $config['reverseDns'] ) ? $config['reverseDns'] : array(), $clock, new Memory_Rdns_Store() );
		$options = array_merge( $config, array( 'now' => $clock ) );
		if ( isset( $inject['signature_library'] ) && 'throws' === $inject['signature_library'] ) {
			$options['signatureLibrary'] = new Throwing_Library();
		}
		$verifier = new Verifier( $store, $rdns, new Memory_Nonce_Store(), $options );
		$settle   = function () use ( $rdns, $store, &$keys_pending ) {
			$rdns->settle();
			if ( $keys_pending ) {
				$keys_pending = false;
				$store->refresh_keys();
			}
		};

		foreach ( $vector['steps'] as $index => $step ) {
			if ( isset( $step['action'] ) && 'refresh' === $step['action'] ) {
				if ( isset( $step['responses'] ) ) {
					$served = $step['responses'];
				}
				if ( $store->refresh_enabled() ) {
					$store->refresh_directory();
					$store->refresh_keys();
				}
				continue;
			}
			if ( ! empty( $step['settle_before'] ) ) {
				$settle();
			}
			if ( ! isset( $step['request'], $step['expected'] ) ) {
				continue;
			}
			$expected = $step['expected'];
			$repeat   = isset( $step['repeat'] ) ? $step['repeat'] : 1;
			for ( $round = 0; $round < $repeat; $round++ ) {
				$request = self::build_request( $step['request'], $api );
				$result  = $verifier->verify( $request );
				$where   = $vector['id'] . ' [' . $api . '] step ' . ( $index + 1 ) . ': ' . ( isset( $result['note'] ) ? $result['note'] : '' ) . ' ' . ( isset( $result['error'] ) ? $result['error'] : '' );
				$this->assertSame( $expected['verdict'], $result['verdict'], $where );
				foreach ( array( 'reason', 'operator', 'agent', 'purpose' ) as $field ) {
					if ( array_key_exists( $field, $expected ) ) {
						$this->assertSame( $expected[ $field ], isset( $result[ $field ] ) ? $result[ $field ] : null, $where . ' (' . $field . ')' );
					}
				}
				if ( array_key_exists( 'method', $expected ) ) {
					$this->assertSame( $expected['method'], isset( $result['method'] ) ? $result['method'] : null, $where . ' (method)' );
				}
				if ( array_key_exists( 'error', $expected ) ) {
					$this->assertSame( $expected['error'], ! empty( $result['error'] ), $where . ' (error)' );
				}
				if ( isset( $expected['stripped'] ) ) {
					$this->assertSame( $expected['stripped'], $request->stripped, $where . ' (stripped)' );
					if ( 'server' === $api ) {
						$server  = self::server_array( $step['request'] );
						$removed = \Posterna\Plugin::strip_inbound_headers( $server );
						$this->assertSame( $expected['stripped'], $removed, $where . ' (strip_inbound_headers)' );
						foreach ( array_keys( $server ) as $key ) {
							$this->assertStringStartsNotWith( 'HTTP_X_AGENT_', $key );
							$this->assertStringStartsNotWith( 'HTTP_X_POSTERNA_', $key );
						}
					}
				}
				if ( isset( $expected['client'] ) ) {
					$resolved = $verifier->resolve( self::build_request( $step['request'], $api ) );
					$this->assertSame( $expected['client']['address'], null === $resolved['address'] ? null : $resolved['address']->text, $where . ' (client)' );
				}
				if ( isset( $expected['verdict_headers'] ) ) {
					$this->assertSame( $expected['verdict_headers'], Verifier::verdict_headers( $result ), $where . ' (headers)' );
				}
			}
		}
		$settle();
		$state = $verifier->state();
		$want  = isset( $vector['expected_state'] ) ? $vector['expected_state'] : array();
		$label = $vector['id'] . ' [' . $api . '] state: ' . (string) $state['lastError'];
		if ( array_key_exists( 'proxySuspect', $want ) ) {
			$this->assertSame( $want['proxySuspect'], $state['proxySuspect'], $label );
		}
		if ( array_key_exists( 'keys_refresh_requested', $want ) ) {
			$requested = false;
			foreach ( $fetches as $url ) {
				if ( 'keys.json' === substr( $url, -9 ) ) {
					$requested = true;
				}
			}
			$this->assertSame( $want['keys_refresh_requested'], $requested, $label );
		}
		if ( array_key_exists( 'fetches', $want ) ) {
			$this->assertCount( $want['fetches'], $fetches, $label );
		}
		if ( array_key_exists( 'errors_at_least', $want ) ) {
			$this->assertGreaterThanOrEqual( $want['errors_at_least'], $state['errors'], $label );
		}
		if ( array_key_exists( 'errors', $want ) ) {
			$this->assertSame( $want['errors'], $state['errors'], $label );
		}
		if ( array_key_exists( 'directory_version', $want ) ) {
			$this->assertSame( $want['directory_version'], $state['directoryVersion'], $label );
		}
		if ( array_key_exists( 'keys_version', $want ) ) {
			$this->assertSame( $want['keys_version'], $state['keysVersion'], $label );
		}
		if ( array_key_exists( 'directory_key_generation', $want ) ) {
			$this->assertSame( $want['directory_key_generation'], $state['directoryKeyGeneration'], $label );
		}
	}

	/**
	 * A verifier for a JWK, as web-bot-auth's verifierFromJWK makes one.
	 *
	 * @param array $jwk JWK.
	 * @return array
	 */
	private static function key_verifier( $jwk ) {
		$key = array(
			'algorithm' => 'ed25519',
			'x'         => $jwk['x'],
		);
		return array(
			'algorithm' => 'ed25519',
			'keyid'     => Index_Builder::thumbprint( $jwk ),
			'verify'    => function ( $data, $signature ) use ( $key ) {
				return Signature_Path::key_verifies( $key, $data, $signature );
			},
		);
	}

	/**
	 * Runs an rfc9421 vector.
	 *
	 * @param array $vector Vector.
	 * @return bool
	 */
	private function run_rfc9421( $vector ) {
		$imported = self::key_verifier( $vector['public_key'] );
		$fields   = array();
		foreach ( $vector['request']['headers'] as $pair ) {
			$fields[] = array(
				'name'  => $pair[0],
				'value' => $pair[1],
			);
		}
		$request = array(
			'method'     => $vector['request']['method'],
			'target_uri' => $vector['request']['target_uri'],
			'fields'     => $fields,
		);
		try {
			if ( 'rfc9421' === $vector['profile'] ) {
				Message_Signature::verify(
					$request,
					array(
						'label'            => $vector['label'],
						'policy'           => array(
							'algorithms'          => array( 'ed25519' ),
							'required_components' => array(),
							'required_parameters' => array(),
							'now'                 => $vector['now'],
						),
						'resolve_verifier' => function () use ( $imported ) {
							return $imported;
						},
					)
				);
			} else {
				Web_Bot_Auth::verify(
					$request,
					array(
						'label'    => $vector['label'],
						'max_age'  => 10000000000,
						'now'      => $vector['now'],
						'resolver' => function () use ( $imported, $vector ) {
							return array_merge( $imported, array( 'keyid' => $vector['keyid'] ) );
						},
					)
				);
			}
			return true;
		} catch ( \Exception $error ) {
			return false;
		}
	}

	/**
	 * Runs a key_directory vector.
	 *
	 * @param array $vector Vector.
	 */
	private function run_key_directory( $vector ) {
		$body = self::read( $vector['snapshot'] );
		$this->assertCount( $vector['expected']['key_count'], $body['keys'] );
		$computed = array();
		foreach ( $body['keys'] as $jwk ) {
			$computed[] = array(
				'kid'        => isset( $jwk['kid'] ) ? $jwk['kid'] : null,
				'thumbprint' => Index_Builder::thumbprint( $jwk ),
			);
		}
		$sort = function ( $keys ) {
			usort(
				$keys,
				function ( $a, $b ) {
					return strcmp( $a['thumbprint'], $b['thumbprint'] );
				}
			);
			return $keys;
		};
		$this->assertSame( $sort( $vector['expected']['keys'] ), $sort( $computed ) );
		$none  = true;
		$thumb = true;
		foreach ( $computed as $key ) {
			$none  = $none && null === $key['kid'];
			$thumb = $thumb && $key['kid'] === $key['thumbprint'];
		}
		$this->assertSame( $vector['expected']['kid_convention'], $none ? 'none' : ( $thumb ? 'thumbprint' : 'short_id' ) );
		$entries = array();
		foreach ( $body['keys'] as $position => $jwk ) {
			$entries[] = array(
				'jwk'        => $jwk,
				'thumbprint' => $computed[ $position ]['thumbprint'],
				'kid'        => $computed[ $position ]['kid'],
			);
		}
		$keys = Index_Builder::compile_keys(
			array(
				'version'   => 'x',
				'operators' => array( 'snapshot' => array( 'keys' => $entries ) ),
			)
		);
		$this->assertSame( array(), $keys['skipped'] );
		$this->assertCount( count( $computed ), $keys['operators']['snapshot']['keys'] );
	}

	/**
	 * Checks that a shipped template equals the vector's policy, byte for byte,
	 * and that the plugin's copy of the template matches it.
	 *
	 * @param string|null $name   Template name.
	 * @param string      $policy Policy text.
	 */
	private function check_template( $name, $policy ) {
		if ( null === $name ) {
			return;
		}
		$this->assertSame( file_get_contents( POSTERNA_TEST_REPO . '/packages/core/templates/' . $name . '.yaml' ), $policy );
		$templates = Policy::templates();
		if ( isset( $templates[ $name ] ) ) {
			$this->assertSame( Policy::from_array( Yaml::parse( $policy ) ), Policy::from_array( $templates[ $name ] ), $name );
		}
	}

	/**
	 * Runs a robots vector.
	 *
	 * @param array $vector Vector.
	 */
	private function run_robots( $vector ) {
		$this->check_template( isset( $vector['template'] ) ? $vector['template'] : null, $vector['policy'] );
		$compiled = Index_Builder::compile_directory( self::read( $vector['directory'] ) );
		$policy   = Policy::from_array( Yaml::parse( $vector['policy'] ) );
		$this->assertSame( $vector['expected'], Robots::emit( $policy, $compiled['directory']['operators'] ) );
	}
}

/**
 * DNS answers from a vector.
 */
final class Fake_Dns implements Dns_Resolver {

	/**
	 * Answers.
	 *
	 * @var array
	 */
	private $answers;

	/**
	 * Injected failure.
	 *
	 * @var string|null
	 */
	private $failure;

	/**
	 * Timeout in milliseconds.
	 *
	 * @var int
	 */
	private $timeout;

	/**
	 * Creates the resolver.
	 *
	 * @param array       $answers Reverse and forward answers.
	 * @param string|null $failure 'timeout', 'error' or null.
	 * @param int         $timeout Timeout in milliseconds.
	 */
	public function __construct( $answers, $failure, $timeout ) {
		$this->answers = $answers;
		$this->failure = $failure;
		$this->timeout = $timeout;
	}

	/**
	 * PTR names.
	 *
	 * @param string $ip Address.
	 * @return array
	 * @throws \RuntimeException On injected failures.
	 */
	public function reverse( $ip ) {
		if ( 'timeout' === $this->failure ) {
			throw new \RuntimeException( 'timed out after ' . $this->timeout . ' ms' );
		}
		if ( 'error' === $this->failure ) {
			throw new \RuntimeException( 'queryPtr ESERVFAIL' );
		}
		return isset( $this->answers['reverse'][ $ip ] ) ? $this->answers['reverse'][ $ip ] : array();
	}

	/**
	 * Addresses.
	 *
	 * @param string $hostname Name.
	 * @return array
	 */
	public function forward( $hostname ) {
		return isset( $this->answers['forward'][ $hostname ] ) ? $this->answers['forward'][ $hostname ] : array();
	}
}

/**
 * A signature library that throws, for failure injection.
 */
final class Throwing_Library implements Signature_Library {

	/**
	 * Throws.
	 *
	 * @param array $request Request.
	 * @param array $options Options.
	 * @throws \TypeError Always.
	 */
	public function web_bot_auth_verify( $request, $options ) {
		throw new \TypeError( 'simulated failure inside the signature library' );
	}

	/**
	 * Throws.
	 *
	 * @param array $request Request.
	 * @param array $options Options.
	 * @throws \TypeError Always.
	 */
	public function verify_signature( $request, $options ) {
		throw new \TypeError( 'simulated failure inside the signature library' );
	}
}
