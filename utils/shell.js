/**
 * Helper to safely quote arguments for shell execution on Windows and Unix.
 * This prevents path splitting when folder names contain spaces or special characters.
 */
function quoteArg(arg) {
    if (!arg) return '""';
    // On Windows, double quotes are standard for shell arguments.
    return `"${arg.toString().replace(/"/g, '\\"')}"`;
}

module.exports = { quoteArg };
