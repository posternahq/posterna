<?php
/**
 * Removes everything Posterna stored when the plugin is deleted.
 *
 * @package Posterna
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

require_once __DIR__ . '/includes/autoload.php';

/**
 * Removes the plugin's table, options, transients and scheduled events for the current site.
 */
function posterna_uninstall_site() {
	global $wpdb;
	foreach ( Posterna\Plugin::cron_hooks() as $hook ) {
		wp_clear_scheduled_hook( $hook );
	}
	Posterna\Counter_Table::drop();
	// Options and transients all start with posterna_; there is no API to list them by prefix.
	// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
	$names = $wpdb->get_col(
		$wpdb->prepare(
			"SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s OR option_name LIKE %s",
			$wpdb->esc_like( 'posterna_' ) . '%',
			$wpdb->esc_like( '_transient_posterna_' ) . '%',
			$wpdb->esc_like( '_transient_timeout_posterna_' ) . '%'
		)
	);
	foreach ( $names as $name ) {
		if ( 0 === strpos( $name, '_transient_timeout_' ) ) {
			continue;
		}
		if ( 0 === strpos( $name, '_transient_' ) ) {
			delete_transient( substr( $name, strlen( '_transient_' ) ) );
		} else {
			delete_option( $name );
		}
	}
}

if ( is_multisite() ) {
	foreach ( get_sites( array( 'fields' => 'ids' ) ) as $posterna_site_id ) {
		switch_to_blog( $posterna_site_id );
		posterna_uninstall_site();
		restore_current_blog();
	}
} else {
	posterna_uninstall_site();
}
