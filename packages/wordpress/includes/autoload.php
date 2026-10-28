<?php
/**
 * Class autoloader for the Posterna namespace.
 *
 * @package Posterna
 */

defined( 'ABSPATH' ) || exit;

/**
 * Loads a Posterna class from a fixed map, with no file-system probing, so
 * the per-request check stays cheap. A unit test keeps the map complete.
 *
 * @param string $class_name Fully qualified class name.
 */
function posterna_autoload( $class_name ) {
	static $map = array(
		'Posterna\\Admin'                                => 'class-admin.php',
		'Posterna\\Counter_Table'                        => 'class-counter-table.php',
		'Posterna\\Directory\\Directory_Signature'       => 'directory/class-directory-signature.php',
		'Posterna\\Directory\\Directory_Storage'         => 'directory/interface-directory-storage.php',
		'Posterna\\Directory\\Directory_Store'           => 'directory/class-directory-store.php',
		'Posterna\\Directory\\Memory_Directory_Storage'  => 'directory/class-memory-directory-storage.php',
		'Posterna\\Directory\\Refresh_Rejected'          => 'directory/class-refresh-rejected.php',
		'Posterna\\Directory\\Trusted_Keys'              => 'directory/class-trusted-keys.php',
		'Posterna\\Options_Directory_Storage'            => 'class-options-directory-storage.php',
		'Posterna\\Php_Dns_Resolver'                     => 'class-php-dns-resolver.php',
		'Posterna\\Plugin'                               => 'class-plugin.php',
		'Posterna\\Policy\\Policy'                       => 'policy/class-policy.php',
		'Posterna\\Policy\\Robots'                       => 'policy/class-robots.php',
		'Posterna\\Signature\\Default_Signature_Library' => 'signature/class-default-signature-library.php',
		'Posterna\\Signature\\Key_Resolution_Error'      => 'signature/class-key-resolution-error.php',
		'Posterna\\Signature\\Message_Signature'         => 'signature/class-message-signature.php',
		'Posterna\\Signature\\Sf_Bytes'                  => 'signature/class-sf-bytes.php',
		'Posterna\\Signature\\Sf_Date'                   => 'signature/class-sf-date.php',
		'Posterna\\Signature\\Sf_Display_String'         => 'signature/class-sf-display-string.php',
		'Posterna\\Signature\\Sf_Error'                  => 'signature/class-sf-error.php',
		'Posterna\\Signature\\Sf_Token'                  => 'signature/class-sf-token.php',
		'Posterna\\Signature\\Signature_Error'           => 'signature/class-signature-error.php',
		'Posterna\\Signature\\Signature_Library'         => 'signature/interface-signature-library.php',
		'Posterna\\Signature\\Signature_Path'            => 'signature/class-signature-path.php',
		'Posterna\\Signature\\Structured_Fields'         => 'signature/class-structured-fields.php',
		'Posterna\\Signature\\Web_Bot_Auth'              => 'signature/class-web-bot-auth.php',
		'Posterna\\Transient_Nonce_Store'                => 'class-transient-nonce-store.php',
		'Posterna\\Transient_Rdns_Store'                 => 'class-transient-rdns-store.php',
		'Posterna\\Verifier\\Address'                    => 'verifier/class-address.php',
		'Posterna\\Verifier\\Automation'                 => 'verifier/class-automation.php',
		'Posterna\\Verifier\\Claim'                      => 'verifier/class-claim.php',
		'Posterna\\Verifier\\Client_Resolver'            => 'verifier/class-client-resolver.php',
		'Posterna\\Verifier\\Directory_Index'            => 'verifier/class-directory-index.php',
		'Posterna\\Verifier\\Dns_Resolver'               => 'verifier/interface-dns-resolver.php',
		'Posterna\\Verifier\\Index_Builder'              => 'verifier/class-index-builder.php',
		'Posterna\\Verifier\\Memory_Nonce_Store'         => 'verifier/class-memory-nonce-store.php',
		'Posterna\\Verifier\\Memory_Rdns_Store'          => 'verifier/class-memory-rdns-store.php',
		'Posterna\\Verifier\\Nonce_Store'                => 'verifier/interface-nonce-store.php',
		'Posterna\\Verifier\\Path_Group'                 => 'verifier/class-path-group.php',
		'Posterna\\Verifier\\Prefix_Matcher'             => 'verifier/class-prefix-matcher.php',
		'Posterna\\Verifier\\Proxy_Guard'                => 'verifier/class-proxy-guard.php',
		'Posterna\\Verifier\\Rdns_Cache'                 => 'verifier/class-rdns-cache.php',
		'Posterna\\Verifier\\Rdns_Store'                 => 'verifier/interface-rdns-store.php',
		'Posterna\\Verifier\\Request'                    => 'verifier/class-request.php',
		'Posterna\\Verifier\\Url'                        => 'verifier/class-url.php',
		'Posterna\\Verifier\\Verifier'                   => 'verifier/class-verifier.php',
	);
	if ( isset( $map[ $class_name ] ) ) {
		require __DIR__ . '/' . $map[ $class_name ];
	}
}

spl_autoload_register( 'posterna_autoload' );
