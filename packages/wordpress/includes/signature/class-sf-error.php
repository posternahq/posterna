<?php
/**
 * Structured Field parse and serialize errors.
 *
 * @package Posterna
 */

namespace Posterna\Signature;

defined( 'ABSPATH' ) || exit;

/**
 * Thrown when a header is not a valid Structured Field, or a value cannot be serialized.
 */
final class Sf_Error extends \Exception {
}
