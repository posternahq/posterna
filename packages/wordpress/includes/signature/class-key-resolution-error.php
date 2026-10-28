<?php
/**
 * Why no key could be chosen for a signature.
 *
 * @package Posterna
 */

namespace Posterna\Signature;

defined( 'ABSPATH' ) || exit;

/**
 * Thrown by the key resolver. The kind decides the outcome: an unknown kid
 * asks for a keys refresh, no keys means nothing to check, and a foreign
 * Signature-Agent means the signature is not one this install can judge.
 */
final class Key_Resolution_Error extends \Exception {

	const UNKNOWN_KEY   = 'unknown_key';
	const NO_KEYS       = 'no_keys';
	const FOREIGN_AGENT = 'foreign_agent';

	/**
	 * One of the constants above.
	 *
	 * @var string
	 */
	public $kind;

	/**
	 * Creates the error.
	 *
	 * @param string $kind    One of the constants above.
	 * @param string $message Message.
	 */
	public function __construct( $kind, $message ) {
		parent::__construct( $message );
		$this->kind = $kind;
	}
}
