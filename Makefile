.PHONY: webp clean deploy deploy-html deploy-static invalidate-cache

BUCKET = derbruden.com
DISTRIBUTION_ID = E3CDWEEK40CKI2

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

deploy: deploy-html deploy-static invalidate-cache
	@echo "Deployment complete"

deploy-html:
	@echo "make deploy-html : Started"
	@echo "Deploying HTML to bucket derbruden.com..."
	@aws s3 rm s3://$(BUCKET)/ --recursive --exclude "*" --include "*.html"
	@aws s3 sync src/ s3://$(BUCKET)/ --delete --exclude "*" --include "*.html" --cache-control "public, max-age=0, must-revalidate"
	@echo "make deploy-html : Finished"

deploy-static:
	@echo "make deploy-static : Started"
	@echo "Deploying static assets to bucket derbruden.com..."
	@aws s3 rm s3://$(BUCKET)/static/ --recursive
	@aws s3 sync static/ s3://$(BUCKET)/static/ --delete --cache-control "public, max-age=31536000, immutable"
	@aws s3 cp static/ico/header-icon-32.png s3://$(BUCKET)/favicon.ico --cache-control "public, max-age=31536000, immutable"
	@echo "make deploy-static : Finished"

invalidate-cache:
	@echo "make invalidate-cache : Started"
	@echo "Invalidating CloudFront cache E3CDWEEK40CKI2..."
	@aws cloudfront create-invalidation --distribution-id $(DISTRIBUTION_ID) --paths "/*"
	@echo "make invalidate-cache : Finished"

clean:
	@echo "make clean : Started"
	@echo "Removing webp files from static/img/ ..."
	@rm -f static/img/*.webp
	@echo "make clean : Finished"
