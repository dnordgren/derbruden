.PHONY: webp clean

# Find all jpg and png files
IMAGES := $(wildcard static/img/*.jpg) $(wildcard static/img/*.png)
# Generate target webp filenames
WEBP_FILES := $(IMAGES:%=%.webp)

webp: $(WEBP_FILES)
	@echo "All images converted to WebP"

%.jpg.webp: %.jpg
	@echo "Converting $< to WebP..."
	@cwebp -quiet -q 80 $< -o $(@:%.jpg.webp=%.webp)
	@rm $<
	@echo "Deleted original: $<"

%.png.webp: %.png
	@echo "Converting $< to WebP..."
	@cwebp -quiet -q 80 $< -o $(@:%.png.webp=%.webp)
	@rm $<
	@echo "Deleted original: $<"

clean:
	@echo "Cleaning up..."
	@rm -f static/img/*.webp
