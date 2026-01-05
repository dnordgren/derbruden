module.exports = function(eleventyConfig) {
  // Passthrough copy for static assets
  eleventyConfig.addPassthroughCopy("static");
  // If you keep css in src/css, copy that too
  // eleventyConfig.addPassthroughCopy("src/css"); 

  eleventyConfig.addFilter("comma", function(num) {
    return num ? num.toLocaleString() : "";
  });
  
  eleventyConfig.addFilter("fixed", function(num, digits) {
    return num ? num.toFixed(digits).replace('0.', '.') : "";
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data"
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    dataTemplateEngine: "njk"
  };
};