exports.normalizeSlug = (value) => String(value).trim().toLowerCase().replace(/\s+/g, '-');
