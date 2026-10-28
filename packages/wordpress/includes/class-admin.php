<?php
/**
 * The Posterna admin page and dashboard widget.
 *
 * @package Posterna
 */

namespace Posterna;

use Posterna\Policy\Policy;
use Posterna\Policy\Robots;
use Posterna\Verifier\Address;
use Posterna\Verifier\Prefix_Matcher;
use Posterna\Verifier\Request;

defined( 'ABSPATH' ) || exit;

/**
 * Everything here needs the manage_options capability. Forms use the
 * Settings API or admin-post.php with a nonce; all output is escaped.
 */
final class Admin {

	const PAGE = 'posterna';

	/**
	 * Adds the admin hooks.
	 */
	public static function register() {
		add_action( 'admin_menu', array( __CLASS__, 'add_menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'admin_post_posterna_refresh', array( __CLASS__, 'handle_refresh' ) );
		add_action( 'admin_post_posterna_send', array( __CLASS__, 'handle_send' ) );
		add_action( 'update_option_' . Plugin::SETTINGS_OPTION, array( __CLASS__, 'settings_saved' ), 10, 2 );
		add_action( 'add_option_' . Plugin::SETTINGS_OPTION, array( __CLASS__, 'settings_added' ), 10, 2 );
		add_filter( 'plugin_action_links_' . plugin_basename( POSTERNA_FILE ), array( __CLASS__, 'action_links' ) );
	}

	/**
	 * Verdict labels.
	 *
	 * @return array Verdict => label.
	 */
	public static function verdict_labels() {
		return array(
			'verified_by_signature' => __( 'Verified by signature', 'posterna' ),
			'verified_by_ip'        => __( 'Verified by IP or DNS', 'posterna' ),
			'declared_unverifiable' => __( 'Claimed, cannot be checked', 'posterna' ),
			'claimed_failed'        => __( 'Claimed, failed the check', 'posterna' ),
			'unknown_automation'    => __( 'Unknown automation', 'posterna' ),
			'human'                 => __( 'Browsers (likely people)', 'posterna' ),
		);
	}

	/**
	 * Adds the Posterna menu item.
	 */
	public static function add_menu() {
		add_menu_page(
			__( 'Posterna', 'posterna' ),
			__( 'Posterna', 'posterna' ),
			'manage_options',
			self::PAGE,
			array( __CLASS__, 'render_page' ),
			'dashicons-visibility',
			81
		);
	}

	/**
	 * A Settings link on the Plugins screen.
	 *
	 * @param array $links Links.
	 * @return array
	 */
	public static function action_links( $links ) {
		$url = add_query_arg(
			array(
				'page' => self::PAGE,
				'tab'  => 'settings',
			),
			admin_url( 'admin.php' )
		);
		array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'posterna' ) . '</a>' );
		return $links;
	}

	/**
	 * Loads the stylesheet on the Posterna page and the dashboard.
	 *
	 * @param string $hook Admin page hook.
	 */
	public static function enqueue( $hook ) {
		if ( 'toplevel_page_' . self::PAGE === $hook || 'index.php' === $hook ) {
			wp_enqueue_style( 'posterna-admin', plugins_url( 'assets/admin.css', POSTERNA_FILE ), array(), POSTERNA_VERSION );
		}
	}

	/**
	 * Registers the settings.
	 */
	public static function register_settings() {
		register_setting(
			'posterna',
			Plugin::SETTINGS_OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'show_in_rest'      => false,
			)
		);
	}

	/**
	 * Checks and cleans submitted settings.
	 *
	 * @param mixed $input Submitted values.
	 * @return array
	 */
	public static function sanitize( $input ) {
		$old   = Plugin::settings();
		$input = is_array( $input ) ? $input : array();
		$clean = $old;

		$mode               = isset( $input['client_ip'] ) ? sanitize_key( $input['client_ip'] ) : 'remote_addr';
		$clean['client_ip'] = in_array( $mode, array( 'remote_addr', 'header', 'hops' ), true ) ? $mode : 'remote_addr';

		$header = isset( $input['client_ip_header'] ) ? strtolower( trim( sanitize_text_field( $input['client_ip_header'] ) ) ) : '';
		if ( '' !== $header && ( ! preg_match( '/^[a-z0-9-]{1,64}$/', $header ) || Request::is_inbound_verdict_header( $header ) ) ) {
			add_settings_error( Plugin::SETTINGS_OPTION, 'posterna_header', __( 'The client address header must be a header name such as cf-connecting-ip.', 'posterna' ) );
			$header = $old['client_ip_header'];
		}
		$clean['client_ip_header'] = $header;
		if ( 'header' === $clean['client_ip'] && '' === $header ) {
			add_settings_error( Plugin::SETTINGS_OPTION, 'posterna_header_missing', __( 'Enter the header name, or choose another way to find the client address. REMOTE_ADDR is used until then.', 'posterna' ) );
			$clean['client_ip'] = 'remote_addr';
		}

		$proxies = array();
		$raw     = isset( $input['trusted_proxies'] ) ? sanitize_textarea_field( $input['trusted_proxies'] ) : '';
		foreach ( preg_split( '/[\s,]+/', $raw, -1, PREG_SPLIT_NO_EMPTY ) as $cidr ) {
			if ( 0 === Prefix_Matcher::compile( array( $cidr ) )->invalid && Prefix_Matcher::compile( array( $cidr ) )->size() > 0 ) {
				$proxies[] = $cidr;
			} else {
				/* translators: %s: the text that is not an address range */
				add_settings_error( Plugin::SETTINGS_OPTION, 'posterna_cidr', sprintf( __( '"%s" is not an address range such as 173.245.48.0/20; it was left out.', 'posterna' ), $cidr ) );
			}
		}
		$clean['trusted_proxies'] = array_slice( array_values( array_unique( $proxies ) ), 0, 200 );
		$clean['hops']            = isset( $input['hops'] ) ? min( 10, max( 1, absint( $input['hops'] ) ) ) : 1;

		$template          = isset( $input['template'] ) ? sanitize_key( $input['template'] ) : 'monitor';
		$clean['template'] = array_key_exists( $template, Policy::templates() ) ? $template : 'monitor';
		$clean['updates']  = ! empty( $input['updates'] );

		$key = isset( $input['site_key'] ) ? trim( sanitize_text_field( $input['site_key'] ) ) : '';
		if ( '' !== $key && ! preg_match( '/^psk_[A-Za-z0-9_-]{43}$/', $key ) ) {
			add_settings_error( Plugin::SETTINGS_OPTION, 'posterna_key', __( 'That does not look like a Posterna site key (it starts with psk_). The previous key was kept.', 'posterna' ) );
			$key = $old['site_key'];
		}
		$clean['site_key']   = $key;
		$clean['setup_done'] = true;
		return $clean;
	}

	/**
	 * After the settings change: schedules what they call for.
	 *
	 * @param mixed $old_value Old settings.
	 * @param mixed $value     New settings.
	 */
	public static function settings_saved( $old_value, $value ) {
		Plugin::sync_schedules();
		$was_on = is_array( $old_value ) && ! empty( $old_value['updates'] );
		if ( is_array( $value ) && ! empty( $value['updates'] ) && ! $was_on ) {
			wp_schedule_single_event( time(), Plugin::CRON_REFRESH_NOW );
		}
	}

	/**
	 * The first save of the settings.
	 *
	 * @param string $option Option name.
	 * @param mixed  $value  Settings.
	 */
	public static function settings_added( $option, $value ) {
		self::settings_saved( array(), $value );
	}

	/**
	 * "Check for updates now".
	 */
	public static function handle_refresh() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'posterna' ), 403 );
		}
		check_admin_referer( 'posterna_refresh' );
		Plugin::instance()->refresh_now();
		wp_safe_redirect( self::url( 'check', array( 'done' => 'refresh' ) ) );
		exit;
	}

	/**
	 * "Send counts now".
	 */
	public static function handle_send() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'posterna' ), 403 );
		}
		check_admin_referer( 'posterna_send' );
		Plugin::instance()->send_counts();
		wp_safe_redirect( self::url( 'check', array( 'done' => 'send' ) ) );
		exit;
	}

	/**
	 * A URL on the Posterna page.
	 *
	 * @param string $tab   Tab.
	 * @param array  $extra Extra query arguments.
	 * @return string
	 */
	private static function url( $tab, $extra = array() ) {
		return add_query_arg(
			array_merge(
				array(
					'page' => self::PAGE,
					'tab'  => $tab,
				),
				$extra
			),
			admin_url( 'admin.php' )
		);
	}

	/**
	 * Tabs.
	 *
	 * @return array Slug => label.
	 */
	private static function tabs() {
		return array(
			'overview' => __( 'Overview', 'posterna' ),
			'agents'   => __( 'Agents', 'posterna' ),
			'paths'    => __( 'Paths', 'posterna' ),
			'signups'  => __( 'Sign-ups', 'posterna' ),
			'check'    => __( 'Check my setup', 'posterna' ),
			'robots'   => __( 'robots.txt', 'posterna' ),
			'settings' => __( 'Settings', 'posterna' ),
		);
	}

	/**
	 * Renders the Posterna page.
	 */
	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		// Reading the tab name only chooses what to show; nothing is changed.
		$tab = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'overview'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$tab = array_key_exists( $tab, self::tabs() ) ? $tab : 'overview';
		echo '<div class="wrap posterna">';
		echo '<h1>' . esc_html__( 'Posterna', 'posterna' ) . '</h1>';
		echo '<p class="posterna-lede">' . esc_html__( 'Which AI agents and crawlers visit this site, and whether they are who they say they are. Version 1.0 only monitors: it labels and counts requests and never blocks anything.', 'posterna' ) . '</p>';
		echo '<nav class="nav-tab-wrapper">';
		foreach ( self::tabs() as $slug => $label ) {
			printf(
				'<a href="%1$s" class="nav-tab%2$s">%3$s</a>',
				esc_url( self::url( $slug ) ),
				$slug === $tab ? ' nav-tab-active' : '',
				esc_html( $label )
			);
		}
		echo '</nav>';
		switch ( $tab ) {
			case 'agents':
				self::render_agents();
				break;
			case 'paths':
				self::render_paths();
				break;
			case 'signups':
				self::render_signups();
				break;
			case 'check':
				self::render_check();
				break;
			case 'robots':
				self::render_robots();
				break;
			case 'settings':
				self::render_settings();
				break;
			default:
				self::render_overview();
		}
		echo '</div>';
	}

	/**
	 * A count, formatted for the site's locale.
	 *
	 * @param int $value Count.
	 * @return string
	 */
	private static function number( $value ) {
		return number_format_i18n( (int) $value );
	}

	/**
	 * The setup panel, shown until the settings are saved once.
	 */
	private static function render_setup() {
		echo '<div class="posterna-card posterna-setup">';
		echo '<h2>' . esc_html__( 'Set up Posterna', 'posterna' ) . '</h2>';
		echo '<p>' . esc_html__( 'Posterna is already labeling and counting requests. Three steps make the numbers right:', 'posterna' ) . '</p>';
		echo '<ol>';
		printf(
			'<li>%1$s <a href="%2$s">%3$s</a></li>',
			esc_html__( 'Make sure Posterna sees each visitor\'s real address, not your proxy\'s.', 'posterna' ),
			esc_url( self::url( 'check' ) ),
			esc_html__( 'Check my setup', 'posterna' )
		);
		printf(
			'<li>%1$s <a href="%2$s">%3$s</a></li>',
			esc_html__( 'Decide on the two optional features: directory updates and the posterna.com connection. Both are off until you turn them on.', 'posterna' ),
			esc_url( self::url( 'settings' ) ),
			esc_html__( 'Settings', 'posterna' )
		);
		printf(
			'<li>%1$s <a href="%2$s">%3$s</a></li>',
			esc_html__( 'Optionally, copy the suggested robots.txt lines into your robots.txt.', 'posterna' ),
			esc_url( self::url( 'robots' ) ),
			esc_html__( 'robots.txt', 'posterna' )
		);
		echo '</ol>';
		echo '<p>' . esc_html__( 'This panel goes away once you save the settings.', 'posterna' ) . '</p>';
		echo '</div>';
	}

	/**
	 * Overview: totals by verdict and new operators.
	 */
	private static function render_overview() {
		if ( ! Plugin::settings()['setup_done'] ) {
			self::render_setup();
		}
		$now   = time();
		$day   = Counter_Table::totals( 'page', $now - DAY_IN_SECONDS );
		$week  = Counter_Table::totals( 'page', $now - WEEK_IN_SECONDS );
		$total = array_sum( $week );
		echo '<h2>' . esc_html__( 'Requests by verdict', 'posterna' ) . '</h2>';
		if ( 0 === $total ) {
			echo '<p>' . esc_html__( 'Nothing counted yet. Requests are counted as they arrive; logged-in users and pages served from a full-page cache are not counted.', 'posterna' ) . '</p>';
		}
		echo '<table class="widefat striped posterna-table"><thead><tr><th>' . esc_html__( 'Verdict', 'posterna' ) . '</th><th class="num">' . esc_html__( 'Last 24 hours', 'posterna' ) . '</th><th class="num">' . esc_html__( 'Last 7 days', 'posterna' ) . '</th></tr></thead><tbody>';
		foreach ( self::verdict_labels() as $verdict => $label ) {
			printf(
				'<tr><td>%1$s</td><td class="num">%2$s</td><td class="num">%3$s</td></tr>',
				esc_html( $label ),
				esc_html( self::number( isset( $day[ $verdict ] ) ? $day[ $verdict ] : 0 ) ),
				esc_html( self::number( isset( $week[ $verdict ] ) ? $week[ $verdict ] : 0 ) )
			);
		}
		echo '</tbody></table>';
		echo '<p class="description">' . esc_html__( 'Verified: the request proved who sent it, with a Web Bot Auth signature or an address the operator publishes. Claimed, failed the check: it named a known agent but came from somewhere that agent does not use. Claimed, cannot be checked: it named an agent whose operator publishes nothing to check against, or a check is still running.', 'posterna' ) . '</p>';

		$new = Counter_Table::new_operators( $now - WEEK_IN_SECONDS );
		echo '<h2>' . esc_html__( 'New operators in the last 7 days', 'posterna' ) . '</h2>';
		if ( array() === $new ) {
			echo '<p>' . esc_html__( 'None.', 'posterna' ) . '</p>';
			return;
		}
		$index = Plugin::instance()->store()->index();
		echo '<table class="widefat striped posterna-table"><thead><tr><th>' . esc_html__( 'Operator', 'posterna' ) . '</th><th>' . esc_html__( 'First seen (UTC)', 'posterna' ) . '</th><th class="num">' . esc_html__( 'Requests', 'posterna' ) . '</th></tr></thead><tbody>';
		foreach ( $new as $row ) {
			printf(
				'<tr><td>%1$s</td><td>%2$s</td><td class="num">%3$s</td></tr>',
				esc_html( self::operator_name( $index, $row['operator'] ) ),
				esc_html( substr( $row['first_seen'], 0, 16 ) ),
				esc_html( self::number( $row['total'] ) )
			);
		}
		echo '</tbody></table>';
	}

	/**
	 * An operator's display name.
	 *
	 * @param \Posterna\Verifier\Directory_Index|null $index Directory.
	 * @param string                                  $slug  Slug.
	 * @return string
	 */
	private static function operator_name( $index, $slug ) {
		$operator = null === $index ? null : $index->operator( $slug );
		return null === $operator ? $slug : $operator['name'];
	}

	/**
	 * Agents: counts by operator, agent and purpose for 7 days.
	 */
	private static function render_agents() {
		$rows  = Counter_Table::by_agent( time() - WEEK_IN_SECONDS, 1000 );
		$pivot = array();
		foreach ( $rows as $row ) {
			$key = $row['operator'] . "\0" . $row['agent'] . "\0" . $row['purpose'];
			if ( ! isset( $pivot[ $key ] ) ) {
				$pivot[ $key ] = array(
					'operator' => $row['operator'],
					'agent'    => $row['agent'],
					'purpose'  => $row['purpose'],
					'counts'   => array(),
					'total'    => 0,
				);
			}
			$pivot[ $key ]['counts'][ $row['verdict'] ] = (int) $row['total'];
			$pivot[ $key ]['total']                    += (int) $row['total'];
		}
		uasort(
			$pivot,
			function ( $a, $b ) {
				return $b['total'] - $a['total'];
			}
		);
		echo '<h2>' . esc_html__( 'Agents in the last 7 days', 'posterna' ) . '</h2>';
		if ( array() === $pivot ) {
			echo '<p>' . esc_html__( 'No requests have named a known agent yet.', 'posterna' ) . '</p>';
			return;
		}
		$index  = Plugin::instance()->store()->index();
		$labels = self::verdict_labels();
		$shown  = array( 'verified_by_signature', 'verified_by_ip', 'declared_unverifiable', 'claimed_failed' );
		echo '<table class="widefat striped posterna-table"><thead><tr><th>' . esc_html__( 'Operator', 'posterna' ) . '</th><th>' . esc_html__( 'Agent', 'posterna' ) . '</th><th>' . esc_html__( 'Purpose', 'posterna' ) . '</th>';
		foreach ( $shown as $verdict ) {
			echo '<th class="num">' . esc_html( $labels[ $verdict ] ) . '</th>';
		}
		echo '<th class="num">' . esc_html__( 'Total', 'posterna' ) . '</th></tr></thead><tbody>';
		foreach ( $pivot as $row ) {
			echo '<tr><td>' . esc_html( self::operator_name( $index, $row['operator'] ) ) . '</td><td>' . esc_html( '' === $row['agent'] ? '-' : $row['agent'] ) . '</td><td>' . esc_html( self::purpose_label( $row['purpose'] ) ) . '</td>';
			foreach ( $shown as $verdict ) {
				echo '<td class="num">' . esc_html( self::number( isset( $row['counts'][ $verdict ] ) ? $row['counts'][ $verdict ] : 0 ) ) . '</td>';
			}
			echo '<td class="num">' . esc_html( self::number( $row['total'] ) ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	/**
	 * A purpose label.
	 *
	 * @param string $purpose Purpose.
	 * @return string
	 */
	private static function purpose_label( $purpose ) {
		$labels = array(
			'training'   => __( 'Training', 'posterna' ),
			'search'     => __( 'Search', 'posterna' ),
			'user_fetch' => __( 'Fetches for a user', 'posterna' ),
			'agent'      => __( 'Agent', 'posterna' ),
			'preview'    => __( 'Link preview', 'posterna' ),
			'ads'        => __( 'Ads', 'posterna' ),
			'other'      => __( 'Other', 'posterna' ),
		);
		return isset( $labels[ $purpose ] ) ? $labels[ $purpose ] : '-';
	}

	/**
	 * Paths: counts by path group for 7 days.
	 */
	private static function render_paths() {
		$pivot = array();
		foreach ( Counter_Table::by_path( time() - WEEK_IN_SECONDS ) as $row ) {
			$group = $row['path_group'];
			if ( ! isset( $pivot[ $group ] ) ) {
				$pivot[ $group ] = array(
					'counts' => array(),
					'total'  => 0,
				);
			}
			$pivot[ $group ]['counts'][ $row['verdict'] ] = (int) $row['total'];
			$pivot[ $group ]['total']                    += (int) $row['total'];
		}
		uasort(
			$pivot,
			function ( $a, $b ) {
				return $b['total'] - $a['total'];
			}
		);
		echo '<h2>' . esc_html__( 'Paths in the last 7 days', 'posterna' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'Paths are grouped by their first segment (/blog/* covers every post under /blog). Segments that look like numbers, IDs or e-mail addresses become /:id/*, and after 50 groups in an hour the rest count as "other".', 'posterna' ) . '</p>';
		if ( array() === $pivot ) {
			echo '<p>' . esc_html__( 'Nothing counted yet.', 'posterna' ) . '</p>';
			return;
		}
		$labels = self::verdict_labels();
		echo '<table class="widefat striped posterna-table"><thead><tr><th>' . esc_html__( 'Path', 'posterna' ) . '</th>';
		foreach ( $labels as $label ) {
			echo '<th class="num">' . esc_html( $label ) . '</th>';
		}
		echo '<th class="num">' . esc_html__( 'Total', 'posterna' ) . '</th></tr></thead><tbody>';
		foreach ( $pivot as $group => $row ) {
			echo '<tr><td><code>' . esc_html( (string) $group ) . '</code></td>';
			foreach ( array_keys( $labels ) as $verdict ) {
				echo '<td class="num">' . esc_html( self::number( isset( $row['counts'][ $verdict ] ) ? $row['counts'][ $verdict ] : 0 ) ) . '</td>';
			}
			echo '<td class="num">' . esc_html( self::number( $row['total'] ) ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	/**
	 * Sign-ups by verdict.
	 */
	private static function render_signups() {
		$now     = time();
		$periods = array(
			__( 'Last 24 hours', 'posterna' ) => Counter_Table::totals( 'signup', $now - DAY_IN_SECONDS ),
			__( 'Last 7 days', 'posterna' )   => Counter_Table::totals( 'signup', $now - WEEK_IN_SECONDS ),
			__( 'Last 30 days', 'posterna' )  => Counter_Table::totals( 'signup', $now - 30 * DAY_IN_SECONDS ),
		);
		echo '<h2>' . esc_html__( 'Sign-ups by verdict', 'posterna' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'New accounts from the WordPress registration form and, when WooCommerce is active, new WooCommerce customers. Posterna only records the verdict of the request that created the account; it never blocks or slows a sign-up, and it does not store who signed up.', 'posterna' ) . '</p>';
		echo '<table class="widefat striped posterna-table"><thead><tr><th>' . esc_html__( 'Verdict', 'posterna' ) . '</th>';
		foreach ( array_keys( $periods ) as $label ) {
			echo '<th class="num">' . esc_html( $label ) . '</th>';
		}
		echo '</tr></thead><tbody>';
		foreach ( self::verdict_labels() as $verdict => $label ) {
			echo '<tr><td>' . esc_html( $label ) . '</td>';
			foreach ( $periods as $totals ) {
				echo '<td class="num">' . esc_html( self::number( isset( $totals[ $verdict ] ) ? $totals[ $verdict ] : 0 ) ) . '</td>';
			}
			echo '</tr>';
		}
		echo '</tbody></table>';
	}

	/**
	 * Full-page caches this site appears to use.
	 *
	 * @return array Names.
	 */
	public static function page_caches() {
		$found = array();
		if ( defined( 'WP_CACHE' ) && WP_CACHE && file_exists( WP_CONTENT_DIR . '/advanced-cache.php' ) ) {
			$found[] = __( 'A page cache drop-in (WP_CACHE is on and wp-content/advanced-cache.php exists)', 'posterna' );
		}
		$constants = array(
			'WP_ROCKET_VERSION'            => 'WP Rocket',
			'W3TC'                         => 'W3 Total Cache',
			'WPCACHEHOME'                  => 'WP Super Cache',
			'LSCWP_V'                      => 'LiteSpeed Cache',
			'CACHE_ENABLER_VERSION'        => 'Cache Enabler',
			'BREEZE_VERSION'               => 'Breeze',
			'WPHB_VERSION'                 => 'Hummingbird',
			'SiteGround_Optimizer\VERSION' => 'Speed Optimizer (SiteGround)',
			'KINSTAMU_VERSION'             => 'Kinsta',
			'PANTHEON_ENVIRONMENT'         => 'Pantheon',
			'ATOMIC_SITE_ID'               => 'WordPress.com or Pressable',
		);
		foreach ( $constants as $constant => $name ) {
			if ( defined( $constant ) ) {
				$found[] = $name;
			}
		}
		if ( class_exists( 'WpFastestCache', false ) ) {
			$found[] = 'WP Fastest Cache';
		}
		if ( function_exists( 'is_wpe' ) && is_wpe() ) {
			$found[] = 'WP Engine';
		}
		return $found;
	}

	/**
	 * A small key-value table row.
	 *
	 * @param string $label Label.
	 * @param string $value Value (escaped here).
	 */
	private static function row( $label, $value ) {
		echo '<tr><th scope="row">' . esc_html( $label ) . '</th><td>' . esc_html( $value ) . '</td></tr>';
	}

	/**
	 * A time as "N minutes ago" or "never".
	 *
	 * @param int|null $time Unix time.
	 * @return string
	 */
	private static function ago( $time ) {
		if ( empty( $time ) ) {
			return __( 'never', 'posterna' );
		}
		/* translators: %s: a time difference such as "5 mins" */
		return sprintf( __( '%s ago', 'posterna' ), human_time_diff( (int) $time, time() ) );
	}

	/**
	 * A scheduled time as "in N minutes" or "not scheduled".
	 *
	 * @param string $hook Cron hook.
	 * @return string
	 */
	private static function next_run( $hook ) {
		$next = wp_next_scheduled( $hook );
		if ( false === $next ) {
			return __( 'not scheduled', 'posterna' );
		}
		if ( $next <= time() ) {
			return __( 'due now', 'posterna' );
		}
		/* translators: %s: a time difference such as "5 mins" */
		return sprintf( __( 'in %s', 'posterna' ), human_time_diff( time(), $next ) );
	}

	/**
	 * Check my setup: how this request was seen, and the common problems.
	 */
	private static function render_check() {
		$plugin   = Plugin::instance();
		$settings = Plugin::settings();
		$state    = Plugin::state();
		$store    = $plugin->store();
		$index    = $store->index();
		$started  = hrtime( true );
		// Read as sent, as on visitor requests; shown only to this administrator, never stored.
		$request  = Request::from_server( $_SERVER ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$verifier = $plugin->verifier();
		$client   = $verifier->resolve( $request );
		$verdict  = $verifier->verify( $request );
		$elapsed  = ( hrtime( true ) - $started ) / 1e6;
		$labels   = self::verdict_labels();
		$remote   = Address::parse( $request->remote_address );

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Only picks a message to show.
		$done = isset( $_GET['done'] ) ? sanitize_key( wp_unslash( $_GET['done'] ) ) : '';
		if ( 'refresh' === $done ) {
			echo '<div class="notice notice-info"><p>' . esc_html__( 'Checked posterna.com for directory updates. The result is below.', 'posterna' ) . '</p></div>';
		} elseif ( 'send' === $done ) {
			echo '<div class="notice notice-info"><p>' . esc_html__( 'Sent waiting counts to posterna.com. The result is below.', 'posterna' ) . '</p></div>';
		}

		$warnings      = array();
		$forward_names = array( 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'forwarded', 'fastly-client-ip', 'x-client-ip' );
		$forwarded     = array();
		foreach ( $forward_names as $name ) {
			$value = $request->value( $name );
			if ( null !== $value ) {
				$forwarded[ $name ] = $value;
			}
		}
		if ( null !== $client['address'] && $client['address']->internal && array() !== $forwarded ) {
			$warnings[] = __( 'Your request reached WordPress from an internal address, and it carries headers a proxy adds. The site is behind a proxy or load balancer, so every visitor may look like the same address. Real crawlers would then fail their checks. Choose how to find the client address in Settings.', 'posterna' );
		} elseif ( null !== $client['address'] && $client['address']->internal ) {
			$warnings[] = __( 'Your request reached WordPress from an internal address. That is normal for a site on your own computer or office network. On a public site it usually means a proxy or load balancer sits in front of WordPress, and every visitor may look like the same address. Ask your host which header carries the visitor\'s address, then choose it in Settings.', 'posterna' );
		} elseif ( Plugin::proxy_suspect() ) {
			$warnings[] = __( 'Most requests in the last day came from internal addresses. The site is probably behind a proxy Posterna has not been told about, so every visitor looks the same. Choose how to find the client address in Settings.', 'posterna' );
		}
		$caches = self::page_caches();
		if ( array() !== $caches ) {
			/* translators: %s: list of cache plugins or hosts */
			$warnings[] = sprintf( __( 'This site uses a full-page cache (%s). Pages served from the cache never run PHP, so Posterna does not see or count those requests. Crawlers that fetch cached pages are undercounted.', 'posterna' ), implode( ', ', $caches ) );
		}
		if ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ) {
			$warnings[] = __( 'WP-Cron is disabled in wp-config.php. Make sure a real cron job calls wp-cron.php, or reverse DNS checks, directory updates and counter sending will not run.', 'posterna' );
		}
		if ( '' !== $settings['site_key'] && isset( $state['key_rejected'] ) && hash( 'sha256', $settings['site_key'] ) === $state['key_rejected'] ) {
			$warnings[] = __( 'posterna.com did not accept the site key, so nothing is being sent. Paste the key again from your dashboard on posterna.com.', 'posterna' );
		}
		if ( null === $index ) {
			$warnings[] = __( 'The operator directory could not be loaded, so every request is labeled only as a browser or unknown automation. Reinstalling the plugin restores the bundled copy.', 'posterna' );
		}

		echo '<h2>' . esc_html__( 'Check my setup', 'posterna' ) . '</h2>';
		if ( array() === $warnings ) {
			echo '<div class="posterna-card posterna-ok"><p>' . esc_html__( 'No problems found.', 'posterna' ) . '</p></div>';
		}
		foreach ( $warnings as $warning ) {
			echo '<div class="posterna-card posterna-warn"><p>' . esc_html( $warning ) . '</p></div>';
		}

		echo '<h3>' . esc_html__( 'How your own request was seen', 'posterna' ) . '</h3>';
		echo '<table class="form-table posterna-kv"><tbody>';
		self::row( __( 'Client address', 'posterna' ), null === $client['address'] ? __( 'unknown', 'posterna' ) : $client['address']->text );
		self::row( __( 'Taken from', 'posterna' ), $client['address_source'] );
		self::row( __( 'Connection address (REMOTE_ADDR)', 'posterna' ), null === $remote ? __( 'none', 'posterna' ) : $remote->text . ( $remote->internal ? ' ' . __( '(internal)', 'posterna' ) : '' ) );
		foreach ( $forwarded as $name => $value ) {
			/* translators: %s: header name */
			self::row( sprintf( __( 'Header %s', 'posterna' ), $name ), $value );
		}
		self::row( __( 'Host signatures are checked against', 'posterna' ), null === $client['host'] ? __( 'unknown', 'posterna' ) : $client['host'] );
		self::row( __( 'Verdict for this request', 'posterna' ), ( isset( $labels[ $verdict['verdict'] ] ) ? $labels[ $verdict['verdict'] ] : $verdict['verdict'] ) . ( isset( $verdict['reason'] ) ? ' (' . $verdict['reason'] . ')' : '' ) );
		/* translators: %s: milliseconds */
		self::row( __( 'Time Posterna took', 'posterna' ), sprintf( __( '%s ms', 'posterna' ), number_format_i18n( $elapsed, 2 ) ) );
		echo '</tbody></table>';

		echo '<h3>' . esc_html__( 'Operator directory', 'posterna' ) . '</h3>';
		$dir_state = $store->state();
		echo '<table class="form-table posterna-kv"><tbody>';
		self::row( __( 'Directory version', 'posterna' ), null === $index ? __( 'not loaded', 'posterna' ) : (string) $index->directory_version() );
		self::row( __( 'Keys version', 'posterna' ), null === $index ? __( 'not loaded', 'posterna' ) : (string) $index->keys_version() );
		self::row( __( 'Source', 'posterna' ), is_array( $dir_state ) && 'downloaded' === $dir_state['source'] ? __( 'downloaded from posterna.com and signature-checked', 'posterna' ) : __( 'the copy bundled with the plugin', 'posterna' ) );
		self::row( __( 'Automatic updates', 'posterna' ), $settings['updates'] ? __( 'on', 'posterna' ) : __( 'off', 'posterna' ) );
		if ( $settings['updates'] ) {
			self::row( __( 'Lowest signing key generation accepted', 'posterna' ), (string) $store->min_generation() );
			foreach ( array(
				'directory' => __( 'Last directory.json check', 'posterna' ),
				'keys'      => __( 'Last keys.json check', 'posterna' ),
			) as $file => $label ) {
				$last = isset( $state['refresh'][ $file ] ) ? $state['refresh'][ $file ] : null;
				if ( null === $last ) {
					self::row( $label, __( 'never', 'posterna' ) );
				} else {
					self::row( $label, self::ago( $last['at'] ) . ': ' . ( $last['ok'] ? __( 'updated', 'posterna' ) : (string) $last['error'] ) );
				}
			}
		}
		echo '</tbody></table>';
		if ( $settings['updates'] ) {
			echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
			wp_nonce_field( 'posterna_refresh' );
			echo '<input type="hidden" name="action" value="posterna_refresh">';
			submit_button( __( 'Check for updates now', 'posterna' ), 'secondary', 'submit', false );
			echo '</form>';
		}

		echo '<h3>' . esc_html__( 'Scheduled jobs (WP-Cron)', 'posterna' ) . '</h3>';
		$runs  = isset( $state['runs'] ) && is_array( $state['runs'] ) ? $state['runs'] : array();
		$queue = get_option( Transient_Rdns_Store::QUEUE_OPTION, array() );
		echo '<table class="form-table posterna-kv"><tbody>';
		self::row( __( 'WP-Cron', 'posterna' ), ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ) ? __( 'disabled in wp-config.php (a real cron job must run it)', 'posterna' ) : __( 'on', 'posterna' ) );
		self::row( __( 'Daily clean-up', 'posterna' ), self::ago( isset( $runs['daily'] ) ? $runs['daily'] : null ) . '; ' . __( 'next', 'posterna' ) . ' ' . self::next_run( Plugin::CRON_DAILY ) );
		self::row( __( 'Reverse DNS lookups', 'posterna' ), Php_Dns_Resolver::available() ? self::ago( isset( $runs['rdns'] ) ? $runs['rdns'] : null ) . '; ' . sprintf( /* translators: %d: number of addresses */ _n( '%d address waiting', '%d addresses waiting', is_array( $queue ) ? count( $queue ) : 0, 'posterna' ), is_array( $queue ) ? count( $queue ) : 0 ) : __( 'not available on this server (dns_get_record is disabled)', 'posterna' ) );
		if ( $settings['updates'] ) {
			self::row( __( 'Hourly keys check', 'posterna' ), self::ago( isset( $runs['hourly'] ) ? $runs['hourly'] : null ) . '; ' . __( 'next', 'posterna' ) . ' ' . self::next_run( Plugin::CRON_HOURLY ) );
		}
		if ( '' !== $settings['site_key'] ) {
			self::row( __( 'Sending counts', 'posterna' ), self::ago( isset( $runs['send'] ) ? $runs['send'] : null ) . '; ' . __( 'next', 'posterna' ) . ' ' . self::next_run( Plugin::CRON_SEND ) );
		}
		echo '</tbody></table>';

		echo '<h3>' . esc_html__( 'Connection to posterna.com', 'posterna' ) . '</h3>';
		echo '<table class="form-table posterna-kv"><tbody>';
		if ( '' === $settings['site_key'] ) {
			self::row( __( 'Status', 'posterna' ), __( 'off (no site key); nothing is sent', 'posterna' ) );
		} else {
			$send = isset( $state['send'] ) ? $state['send'] : null;
			self::row( __( 'Status', 'posterna' ), __( 'on', 'posterna' ) );
			self::row( __( 'Last send', 'posterna' ), null === $send ? __( 'never', 'posterna' ) : self::ago( $send['at'] ) . ': ' . ( $send['ok'] ? __( 'accepted', 'posterna' ) : (string) $send['error'] ) );
			$override = array_key_exists( 'remote_override', $state ) ? $state['remote_override'] : null;
			self::row( __( 'Remote mode override', 'posterna' ), 'monitor' === $override ? __( 'monitor (version 1.0 always monitors)', 'posterna' ) : __( 'none', 'posterna' ) );
		}
		echo '</tbody></table>';
		if ( '' !== $settings['site_key'] ) {
			echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
			wp_nonce_field( 'posterna_send' );
			echo '<input type="hidden" name="action" value="posterna_send">';
			submit_button( __( 'Send counts now', 'posterna' ), 'secondary', 'submit', false );
			echo '</form>';
		}
	}

	/**
	 * Suggested robots.txt lines.
	 */
	private static function render_robots() {
		$settings  = Plugin::settings();
		$templates = Policy::templates();
		$name      = isset( $templates[ $settings['template'] ] ) ? $settings['template'] : 'monitor';
		$index     = Plugin::instance()->store()->index();
		echo '<h2>' . esc_html__( 'Suggested robots.txt lines', 'posterna' ) . '</h2>';
		echo '<p>' . esc_html__( 'These lines state your preferences to crawlers that honor robots.txt, and add Content Signals (contentsignals.org) that say how your content may be used. Posterna never changes robots.txt. Copy what you want into your robots.txt yourself, for example with your SEO plugin\'s robots.txt editor. Choose the template in Settings.', 'posterna' ) . '</p>';
		if ( null === $index ) {
			echo '<p>' . esc_html__( 'The operator directory is not loaded, so there is nothing to suggest.', 'posterna' ) . '</p>';
			return;
		}
		$header = array(
			'# Suggested by the Posterna WordPress plugin from the "' . $name . '" template.',
			'# Crawlers that honor robots.txt are asked to stay out of what the template blocks.',
			'# Posterna 1.0 only monitors: it does not block agents that ignore robots.txt.',
		);
		$text   = Robots::emit( Policy::from_array( $templates[ $name ] ), $index->operators(), $header );
		echo '<p><strong>' . esc_html(
			'allow-list' === $name
				? __( 'Template: allow-list. Agents that fetch pages to train AI models are asked to stay out; everything else is allowed.', 'posterna' )
				: __( 'Template: monitor. Everything is allowed; only Content Signals and an open group are written.', 'posterna' )
		) . '</strong></p>';
		echo '<textarea class="large-text code posterna-robots" rows="20" readonly>' . esc_textarea( $text ) . '</textarea>';
	}

	/**
	 * The settings form.
	 */
	private static function render_settings() {
		$settings = Plugin::settings();
		$option   = Plugin::SETTINGS_OPTION;
		settings_errors( $option );
		echo '<form method="post" action="' . esc_url( admin_url( 'options.php' ) ) . '">';
		settings_fields( 'posterna' );

		echo '<h2>' . esc_html__( 'Client address', 'posterna' ) . '</h2>';
		echo '<p>' . esc_html__( 'Crawlers are checked against the addresses their operators publish, so Posterna must see each visitor\'s real address. Use Check my setup to see what it sees now.', 'posterna' ) . '</p>';
		echo '<fieldset class="posterna-fieldset">';
		$modes = array(
			'remote_addr' => __( 'The connection address (REMOTE_ADDR). Right for most sites, and for hosts that already put the visitor\'s address there.', 'posterna' ),
			'header'      => __( 'A header that my host or proxy always sets to the visitor\'s address:', 'posterna' ),
			'hops'        => __( 'X-Forwarded-For, with this many proxies in front of WordPress:', 'posterna' ),
		);
		foreach ( $modes as $mode => $label ) {
			printf(
				'<p><label><input type="radio" name="%1$s[client_ip]" value="%2$s"%3$s> %4$s</label></p>',
				esc_attr( $option ),
				esc_attr( $mode ),
				checked( $settings['client_ip'], $mode, false ),
				esc_html( $label )
			);
			if ( 'header' === $mode ) {
				printf(
					'<p class="posterna-indent"><label>%1$s <input type="text" class="regular-text code" name="%2$s[client_ip_header]" value="%3$s" placeholder="cf-connecting-ip"></label></p>',
					esc_html__( 'Header name', 'posterna' ),
					esc_attr( $option ),
					esc_attr( $settings['client_ip_header'] )
				);
				printf(
					'<p class="posterna-indent"><label>%1$s<br><textarea class="large-text code" rows="4" name="%2$s[trusted_proxies]">%3$s</textarea></label></p>',
					esc_html__( 'Optional: read the header only from these proxy address ranges (one per line). Strongly recommended, because otherwise a visitor who reaches the server directly can set the header to any address.', 'posterna' ),
					esc_attr( $option ),
					esc_textarea( implode( "\n", $settings['trusted_proxies'] ) )
				);
			}
			if ( 'hops' === $mode ) {
				printf(
					'<p class="posterna-indent"><input type="number" min="1" max="10" class="small-text" name="%1$s[hops]" value="%2$s"></p>',
					esc_attr( $option ),
					esc_attr( (string) $settings['hops'] )
				);
			}
		}
		echo '</fieldset>';
		echo '<details class="posterna-hosts"><summary>' . esc_html__( 'Settings for common hosts', 'posterna' ) . '</summary><ul>';
		echo '<li>' . esc_html__( 'Behind Cloudflare: header cf-connecting-ip, and paste the IPv4 and IPv6 ranges Cloudflare publishes as the proxy ranges. Cloudflare documents both in "Restoring original visitor IPs" and says to accept traffic only from its addresses, or the header can be forged. The plugin\'s FAQ has the links.', 'posterna' ) . '</li>';
		printf(
			'<li>%1$s <a href="%2$s">%3$s</a></li>',
			esc_html__( 'Pantheon: REMOTE_ADDR already holds the visitor\'s address, so keep the first option. Behind Cloudflare as well, use cf-connecting-ip.', 'posterna' ),
			esc_url( 'https://docs.pantheon.io/client-ip' ),
			esc_html__( 'Pantheon documentation', 'posterna' )
		);
		echo '<li>' . esc_html__( 'Other hosts: ask your host which header carries the visitor\'s address and whether its proxy always overwrites it. Then confirm with Check my setup.', 'posterna' ) . '</li>';
		echo '</ul></details>';

		echo '<h2>' . esc_html__( 'robots.txt template', 'posterna' ) . '</h2>';
		$templates = array(
			'monitor'    => __( 'Monitor: allow everything.', 'posterna' ),
			'allow-list' => __( 'Allow-list: ask AI training crawlers to stay out; allow everything else.', 'posterna' ),
		);
		foreach ( $templates as $template => $label ) {
			printf(
				'<p><label><input type="radio" name="%1$s[template]" value="%2$s"%3$s> %4$s</label></p>',
				esc_attr( $option ),
				esc_attr( $template ),
				checked( $settings['template'], $template, false ),
				esc_html( $label )
			);
		}
		echo '<p class="description">' . esc_html__( 'Only changes the suggested lines on the robots.txt tab. Nothing is blocked either way.', 'posterna' ) . '</p>';

		echo '<h2>' . esc_html__( 'Directory updates (optional, off by default)', 'posterna' ) . '</h2>';
		printf(
			'<p><label><input type="checkbox" name="%1$s[updates]" value="1"%2$s> %3$s</label></p>',
			esc_attr( $option ),
			checked( (bool) $settings['updates'], true, false ),
			esc_html__( 'Download updates to the operator directory from posterna.com', 'posterna' )
		);
		echo '<p class="description">' . esc_html__( 'The plugin includes a copy of the directory of AI operators, their agents, published IP ranges and signing keys. Operators change these often. When this is on, your site downloads the latest directory.json once a day and keys.json once an hour from https://posterna.com/v1/, and uses them only if their signature checks out against keys built into the plugin. Your site sends nothing but a plain download request: no site address, visitor data or counts. When off, the bundled copy is used until you update the plugin.', 'posterna' ) . '</p>';

		echo '<h2>' . esc_html__( 'Connection to posterna.com (optional, off by default)', 'posterna' ) . '</h2>';
		printf(
			'<p><label>%1$s<br><input type="text" class="regular-text code" autocomplete="off" name="%2$s[site_key]" value="%3$s" placeholder="psk_..."></label></p>',
			esc_html__( 'Site key', 'posterna' ),
			esc_attr( $option ),
			esc_attr( $settings['site_key'] )
		);
		echo '<p class="description">' . esc_html__( 'Everything on this page works without an account. To see this site on the posterna.com dashboard as well, add the site there and paste its site key here. Every five minutes the site then sends the same counts shown on this page: per hour, how many requests got each verdict, by operator, agent, purpose and path group. It never sends IP addresses, full URLs, headers, request bodies, user names or e-mail addresses. Clear the field to stop.', 'posterna' ) . '</p>';
		printf(
			'<p class="description">%1$s <a href="https://posterna.com/terms">%2$s</a> &middot; <a href="https://posterna.com/privacy">%3$s</a></p>',
			esc_html__( 'posterna.com:', 'posterna' ),
			esc_html__( 'Terms', 'posterna' ),
			esc_html__( 'Privacy', 'posterna' )
		);

		submit_button( __( 'Save settings', 'posterna' ) );
		echo '</form>';
	}

	/**
	 * Adds the dashboard widget for administrators.
	 */
	public static function add_dashboard_widget() {
		if ( current_user_can( 'manage_options' ) ) {
			wp_add_dashboard_widget( 'posterna_summary', __( 'Posterna: last 24 hours', 'posterna' ), array( __CLASS__, 'render_widget' ) );
		}
	}

	/**
	 * The dashboard widget.
	 */
	public static function render_widget() {
		$totals = Counter_Table::totals( 'page', time() - DAY_IN_SECONDS );
		echo '<table class="posterna-widget"><tbody>';
		foreach ( self::verdict_labels() as $verdict => $label ) {
			printf(
				'<tr><td>%1$s</td><td class="num">%2$s</td></tr>',
				esc_html( $label ),
				esc_html( self::number( isset( $totals[ $verdict ] ) ? $totals[ $verdict ] : 0 ) )
			);
		}
		echo '</tbody></table>';
		printf( '<p><a href="%1$s">%2$s</a></p>', esc_url( self::url( 'overview' ) ), esc_html__( 'Open Posterna', 'posterna' ) );
	}
}
