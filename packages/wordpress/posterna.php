<?php
/**
 * Plugin Name:       Posterna
 * Plugin URI:        https://posterna.com
 * Description:       See which AI agents and crawlers visit your site and whether they are who they say they are. Monitor only: nothing is blocked.
 * Version:           1.0.0
 * Requires at least: 6.5
 * Requires PHP:      8.0
 * Author:            Posterna
 * Author URI:        https://posterna.com
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       posterna
 *
 * @package Posterna
 */

defined( 'ABSPATH' ) || exit;

define( 'POSTERNA_VERSION', '1.0.0' );
define( 'POSTERNA_FILE', __FILE__ );
define( 'POSTERNA_DIR', __DIR__ );

require_once __DIR__ . '/includes/autoload.php';
require_once __DIR__ . '/includes/functions.php';

// Strips inbound X-Agent-* and X-Posterna-* headers right away, then adds the hooks.
Posterna\Plugin::boot();

register_activation_hook( __FILE__, array( 'Posterna\Plugin', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'Posterna\Plugin', 'deactivate' ) );
