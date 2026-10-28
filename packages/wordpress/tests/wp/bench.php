<?php
/**
 * Measures Posterna's per-request check inside WordPress, with the real
 * directory, for typical requests. Run with:
 * wp eval-file wp-content/posterna-tests/bench.php
 *
 * Prints JSON: median and 99th percentile in milliseconds per request type,
 * and the cost of one counter write.
 *
 * @package Posterna
 */

use Posterna\Counter_Table;
use Posterna\Plugin;
use Posterna\Verifier\Request;

defined( 'ABSPATH' ) || exit;

$posterna_bench_cases = array(
	'browser'               => array(
		'REMOTE_ADDR'          => '203.0.113.10',
		'HTTP_HOST'            => wp_parse_url( home_url(), PHP_URL_HOST ),
		'HTTP_USER_AGENT'      => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
		'HTTP_ACCEPT'          => 'text/html,application/xhtml+xml',
		'HTTP_ACCEPT_LANGUAGE' => 'en-US,en;q=0.9',
		'HTTP_COOKIE'          => 'a=b; c=d',
	),
	'curl'                  => array(
		'REMOTE_ADDR'     => '203.0.113.11',
		'HTTP_USER_AGENT' => 'curl/8.7.1',
		'HTTP_ACCEPT'     => '*/*',
	),
	'googlebot_from_google' => array(
		'REMOTE_ADDR'     => '66.249.66.1',
		'HTTP_USER_AGENT' => 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
		'HTTP_ACCEPT'     => '*/*',
	),
	'gptbot_spoofed'        => array(
		'REMOTE_ADDR'     => '203.0.113.12',
		'HTTP_USER_AGENT' => 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3; +https://openai.com/gptbot)',
		'HTTP_ACCEPT'     => '*/*',
	),
	'amazonbot_spoofed'     => array(
		'REMOTE_ADDR'     => '203.0.113.13',
		'HTTP_USER_AGENT' => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)',
		'HTTP_ACCEPT'     => '*/*',
	),
);

$posterna_bench_plugin = Plugin::instance();
$posterna_bench_out    = array();
foreach ( $posterna_bench_cases as $posterna_bench_name => $posterna_bench_server ) {
	$posterna_bench_server = array_merge(
		array(
			'REQUEST_METHOD' => 'GET',
			'REQUEST_URI'    => '/blog/hello-world/',
			'HTTPS'          => 'on',
		),
		$posterna_bench_server
	);
	$posterna_bench_times  = array();
	$posterna_bench_result = null;
	for ( $posterna_bench_i = 0; $posterna_bench_i < 2000; $posterna_bench_i++ ) {
		$posterna_bench_start  = hrtime( true );
		$posterna_bench_req    = Request::from_server( $posterna_bench_server );
		$posterna_bench_result = $posterna_bench_plugin->verifier()->verify( $posterna_bench_req );
		$posterna_bench_times[] = ( hrtime( true ) - $posterna_bench_start ) / 1e6;
	}
	sort( $posterna_bench_times );
	$posterna_bench_out[ $posterna_bench_name ] = array(
		'verdict' => $posterna_bench_result['verdict'] . ( isset( $posterna_bench_result['reason'] ) ? ' (' . $posterna_bench_result['reason'] . ')' : '' ),
		'p50_ms'  => round( $posterna_bench_times[ 1000 ], 4 ),
		'p99_ms'  => round( $posterna_bench_times[ 1980 ], 4 ),
	);
}

// One counter write, as at the end of a counted request.
$posterna_bench_times = array();
for ( $posterna_bench_i = 0; $posterna_bench_i < 500; $posterna_bench_i++ ) {
	$posterna_bench_start = hrtime( true );
	Counter_Table::record( 'page', array( 'verdict' => 'human' ), '/bench/*', false, time() );
	$posterna_bench_times[] = ( hrtime( true ) - $posterna_bench_start ) / 1e6;
}
sort( $posterna_bench_times );
$posterna_bench_out['counter_write'] = array(
	'p50_ms' => round( $posterna_bench_times[ 250 ], 4 ),
	'p99_ms' => round( $posterna_bench_times[ 495 ], 4 ),
);
global $wpdb;
$wpdb->query( $wpdb->prepare( 'DELETE FROM %i WHERE path_group = %s', Counter_Table::name(), '/bench/*' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
$posterna_bench_out['php'] = PHP_VERSION;
$posterna_bench_out['sodium'] = extension_loaded( 'sodium' ) ? 'ext-sodium' : 'sodium_compat';
echo wp_json_encode( $posterna_bench_out, JSON_PRETTY_PRINT ) . "\n";
