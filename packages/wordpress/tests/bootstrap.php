<?php
/**
 * Bootstrap for the plugin's unit tests, which run without WordPress.
 *
 * @package Posterna
 */

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}

require_once dirname( __DIR__ ) . '/vendor/autoload.php';
require_once dirname( __DIR__ ) . '/includes/autoload.php';

define( 'POSTERNA_TEST_REPO', dirname( __DIR__, 3 ) );
