<?php
/**
 * Checks of the PHP port that the conformance vectors do not cover.
 *
 * @package Posterna
 */

namespace Posterna\Tests;

use PHPUnit\Framework\TestCase;
use Posterna\Directory\Directory_Signature;
use Posterna\Directory\Trusted_Keys;
use Posterna\Signature\Sf_Bytes;
use Posterna\Signature\Sf_Error;
use Posterna\Signature\Sf_Token;
use Posterna\Signature\Structured_Fields;
use Posterna\Verifier\Address;
use Posterna\Verifier\Index_Builder;
use Posterna\Verifier\Path_Group;
use Posterna\Verifier\Prefix_Matcher;
use Posterna\Verifier\Url;

/**
 * Port checks.
 */
final class PortTest extends TestCase {

	/**
	 * The trusted directory keys equal core's TRUSTED_DIRECTORY_KEYS.
	 */
	public function test_trusted_keys_match_core() {
		$source = file_get_contents( POSTERNA_TEST_REPO . '/packages/core/src/directory/signature.ts' );
		preg_match_all( '/kid: "([^"]+)",\s*role: "(primary|backup)",\s*generation: (\d+),\s*added: "([^"]+)",\s*jwk: \{ kty: "OKP", crv: "Ed25519", x: "([^"]+)" \}/', $source, $matches, PREG_SET_ORDER );
		$this->assertNotEmpty( $matches );
		$core = array();
		foreach ( $matches as $match ) {
			$core[] = array(
				'kid'        => $match[1],
				'role'       => $match[2],
				'generation' => (int) $match[3],
				'added'      => $match[4],
				'jwk'        => array(
					'kty' => 'OKP',
					'crv' => 'Ed25519',
					'x'   => $match[5],
				),
			);
		}
		$this->assertSame( $core, Trusted_Keys::all() );
		foreach ( Trusted_Keys::all() as $key ) {
			$this->assertSame( $key['kid'], Index_Builder::thumbprint( $key['jwk'] ) );
		}
	}

	/**
	 * The autoloader's class map lists every class and interface in includes/.
	 */
	public function test_autoload_map_is_complete() {
		$iterator = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( dirname( __DIR__, 2 ) . '/includes', \FilesystemIterator::SKIP_DOTS ) );
		$declared = 0;
		foreach ( $iterator as $file ) {
			if ( ! preg_match( '/^(class|interface)-.*\.php$/', $file->getFilename() ) ) {
				continue;
			}
			$source = file_get_contents( $file->getPathname() );
			preg_match( '/^namespace ([\w\\\\]+);/m', $source, $namespace );
			preg_match( '/^(?:final )?(?:class|interface) (\w+)/m', $source, $name );
			$class = $namespace[1] . '\\' . $name[1];
			$this->assertTrue( class_exists( $class ) || interface_exists( $class ), $class . ' is not in includes/autoload.php' );
			++$declared;
		}
		$this->assertGreaterThan( 40, $declared );
	}

	/**
	 * A keys.json published by posterna.com verifies under the trusted primary key.
	 */
	public function test_production_release_signature() {
		$dir   = POSTERNA_TEST_REPO . '/packages/core/test/fixtures/production-release/';
		$body  = file_get_contents( $dir . 'keys.json' );
		$sig   = file_get_contents( $dir . 'keys.json.sig' );
		$check = Directory_Signature::check( $body, $sig, Trusted_Keys::all(), 1 );
		$this->assertTrue( $check['ok'] );
		$this->assertSame( 1, $check['generation'] );
		$this->assertSame( 'signature_untrusted', Directory_Signature::check( $body . ' ', $sig, Trusted_Keys::all(), 1 )['reason'] );
		$this->assertSame( 'signature_retired', Directory_Signature::check( $body, $sig, Trusted_Keys::all(), 2 )['reason'] );
		$this->assertSame( 'signature_malformed', Directory_Signature::check( $body, 'not a signature', Trusted_Keys::all(), 1 )['reason'] );
	}

	/**
	 * The bundled snapshot is the directory package's data, and compiles with no skipped keys.
	 */
	public function test_bundled_snapshot() {
		$plugin = dirname( __DIR__, 2 ) . '/data/';
		$source = POSTERNA_TEST_REPO . '/packages/directory/data/';
		foreach ( array( 'directory.json', 'keys.json' ) as $file ) {
			$this->assertSame( sha1_file( $source . $file ), sha1_file( $plugin . $file ), $file . ' differs from packages/directory/data; copy it again.' );
		}
		$compiled = Index_Builder::compile_directory( json_decode( file_get_contents( $plugin . 'directory.json' ), true ) );
		$keys     = Index_Builder::compile_keys( json_decode( file_get_contents( $plugin . 'keys.json' ), true ) );
		$this->assertSame( array(), $keys['skipped'] );
		$this->assertArrayHasKey( 'google', $compiled['directory']['operators'] );
		$this->assertArrayHasKey( 'googlebot', $compiled['directory']['tokens'] );
		// The autoloaded part stays small: IP ranges are stored apart.
		$this->assertLessThan( 200000, strlen( serialize( $compiled['directory'] ) ) + strlen( serialize( $keys ) ) );
	}

	/**
	 * Path groups, as in core's counters tests.
	 */
	public function test_path_groups() {
		$this->assertSame( '/docs/*', Path_Group::first_segment( '/docs/intro' ) );
		$this->assertSame( '/', Path_Group::first_segment( '/' ) );
		$this->assertSame( '/', Path_Group::first_segment( '' ) );
		foreach ( array( '/12345/profile', '/@alice', '/alice%40example.com', '/550e8400-e29b-41d4-a716-446655440000', '/0123456789abcdef0123', '/eyJhbGciOiJIUzI1NiJ9abc', '/a%20b', '/' . str_repeat( 'x', 40 ) ) as $path ) {
			$this->assertSame( '/:id/*', Path_Group::first_segment( $path ), $path );
		}
		foreach ( array( '/blog', '/blog/2026/10/post', '/pricing', '/v1/things', '/robots.txt/', '/assets/app.js', '/.well-known' ) as $path ) {
			$this->assertSame( '/' . explode( '/', $path )[1] . '/*', Path_Group::first_segment( $path ), $path );
		}
		foreach ( array( '/robots.txt', '/favicon.ico', '/sitemap.xml', '/llms.txt' ) as $path ) {
			$this->assertSame( $path, Path_Group::first_segment( $path ), $path );
		}
		foreach ( array( '/alice@example.com', '/0123456789abcdef0123.json', '/550e8400-e29b-41d4-a716-446655440000.png/x', '/12345.html' ) as $path ) {
			$this->assertSame( '/:id/*', Path_Group::first_segment( $path ), $path );
		}
	}

	/**
	 * Addresses and prefixes.
	 */
	public function test_addresses() {
		$this->assertSame( '203.0.113.9', Address::parse( '203.0.113.9:443' )->text );
		$this->assertSame( '2001:db8::1', Address::parse( '[2001:DB8:0:0:0:0:0:1]:8080' )->text );
		$this->assertSame( '192.0.2.1', Address::parse( '::ffff:192.0.2.1' )->text );
		$this->assertSame( '2001:db8:0:1:1:1:1:1', Address::parse( '2001:db8:0:1:1:1:1:1' )->text );
		$this->assertSame( '2001:0:0:1::1', Address::parse( '2001:0:0:1:0:0:0:1' )->text );
		$this->assertNull( Address::parse( '010.0.0.1' ) );
		$this->assertNull( Address::parse( 'fe80::1%eth0' ) );
		$this->assertNull( Address::parse( 'unknown' ) );
		$this->assertTrue( Address::parse( '10.1.2.3' )->internal );
		$this->assertTrue( Address::parse( '100.64.0.1' )->internal );
		$this->assertTrue( Address::parse( 'fd00::1' )->internal );
		$this->assertFalse( Address::parse( '8.8.8.8' )->internal );
		$matcher = Prefix_Matcher::compile( array( '192.0.2.0/24', '198.51.100.7/32', '2001:db8::/32', 'nonsense', '10.0.0.0/33' ) );
		$this->assertSame( 2, $matcher->invalid );
		$this->assertTrue( $matcher->has( Address::parse( '192.0.2.200' ) ) );
		$this->assertFalse( $matcher->has( Address::parse( '192.0.3.1' ) ) );
		$this->assertTrue( $matcher->has( Address::parse( '198.51.100.7' ) ) );
		$this->assertFalse( $matcher->has( Address::parse( '198.51.100.8' ) ) );
		$this->assertTrue( $matcher->has( Address::parse( '2001:db8:ffff::1' ) ) );
		$this->assertFalse( $matcher->has( Address::parse( '2001:db9::1' ) ) );
		$this->assertTrue( Prefix_Matcher::from_packed( $matcher->to_packed() )->has( Address::parse( '192.0.2.1' ) ) );
	}

	/**
	 * URL parsing for @authority and Signature-Agent origins.
	 */
	public function test_urls() {
		$this->assertSame( 'https://signer.example', Url::signature_agent_origin( 'HTTPS://Signer.Example/' ) );
		$this->assertSame( 'https://signer.example:8443', Url::signature_agent_origin( 'https://signer.example:8443' ) );
		$this->assertSame( 'https://signer.example', Url::signature_agent_origin( 'https://signer.example:443' ) );
		$this->assertNull( Url::signature_agent_origin( 'https://signer.example/keys' ) );
		$this->assertNull( Url::signature_agent_origin( 'http://signer.example' ) );
		$this->assertNull( Url::signature_agent_origin( 'https://user@signer.example' ) );
		$this->assertNull( Url::signature_agent_origin( 'https://signer.example/?x' ) );
		$this->assertSame( 'www.site.example', Url::parse( 'https://www.site.example:443/a?b' )['host'] );
		$this->assertSame( '127.0.0.1', Url::parse( 'http://0x7f.1/' )['host'] );
		$this->assertNull( Url::parse( 'https://bad host/' ) );
		$this->assertNull( Url::parse( 'https://example.999/' ) );
	}

	/**
	 * Structured Field parsing and serializing.
	 */
	public function test_structured_fields() {
		$dictionary = Structured_Fields::parse_dictionary( 'sig1=("@authority" "signature-agent";key="sig1");created=1;keyid="k";tag="web-bot-auth", b=:AQID:, c, d=tok/en;x=?0' );
		$this->assertSame( '("@authority" "signature-agent";key="sig1");created=1;keyid="k";tag="web-bot-auth"', Structured_Fields::serialize_inner_list( $dictionary['sig1'] ) );
		$this->assertInstanceOf( Sf_Bytes::class, $dictionary['b'][0] );
		$this->assertSame( "\x01\x02\x03", $dictionary['b'][0]->bytes );
		$this->assertTrue( $dictionary['c'][0] );
		$this->assertInstanceOf( Sf_Token::class, $dictionary['d'][0] );
		$this->assertFalse( $dictionary['d'][1]['x'] );
		$this->assertSame( '"a\\"b"', Structured_Fields::serialize_bare_item( 'a"b' ) );
		$this->assertSame( '1.5', Structured_Fields::serialize_bare_item( 1.5 ) );
		$this->assertSame( '2', Structured_Fields::serialize_bare_item( 2.0 ) );
		foreach ( array( 'a=1,', 'A=1', 'a=(1 2', 'a="x', 'a=:@@:', 'a=1.2345' ) as $bad ) {
			try {
				Structured_Fields::parse_dictionary( $bad );
				$this->fail( 'parsed ' . $bad );
			} catch ( Sf_Error $error ) {
				$this->assertNotEmpty( $error->getMessage() );
			}
		}
	}
}
