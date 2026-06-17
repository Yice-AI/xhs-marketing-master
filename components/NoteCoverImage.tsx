import React, { useEffect, useMemo, useState } from 'react';

interface NoteCoverImageProps {
  alt: string;
  className?: string;
  imageUrl?: string | null;
  imageList?: Array<string | null | undefined>;
  stableImageUrl?: string | null;
  stableImageList?: Array<string | null | undefined>;
  resolvedImageUrl?: string | null;
  resolvedImageList?: Array<string | null | undefined>;
  referrerPolicy?: React.ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
  preferImageUrl?: boolean;
  loading?: React.ImgHTMLAttributes<HTMLImageElement>['loading'];
  decoding?: React.ImgHTMLAttributes<HTMLImageElement>['decoding'];
  fetchPriority?: React.ImgHTMLAttributes<HTMLImageElement>['fetchPriority'];
}

const DEFAULT_PLACEHOLDER = 'https://picsum.photos/400/533?grayscale&blur=1';
const SCRAPER_IMAGE_PROXY_PREFIX = '/api/scraper/image-proxy?url=';

const normalizeCandidateIdentity = (value: string) => {
  let candidate = value.trim();
  if (!candidate) return '';
  if (candidate.startsWith(SCRAPER_IMAGE_PROXY_PREFIX)) {
    const encoded = candidate.slice(SCRAPER_IMAGE_PROXY_PREFIX.length);
    try {
      candidate = decodeURIComponent(encoded);
    } catch {
      candidate = encoded;
    }
  }
  if (candidate.startsWith('http://')) {
    candidate = candidate.replace(/^http:\/\//i, 'https://');
  }
  return candidate;
};

const NoteCoverImage: React.FC<NoteCoverImageProps> = ({
  alt,
  className,
  imageUrl,
  imageList,
  stableImageUrl,
  stableImageList,
  resolvedImageUrl,
  resolvedImageList,
  referrerPolicy = 'no-referrer',
  preferImageUrl = false,
  loading = 'lazy',
  decoding = 'async',
  fetchPriority = 'auto',
}) => {
  const candidates = useMemo(() => {
    const orderedUrls = preferImageUrl
      ? [
          imageUrl,
          ...(imageList || []),
          resolvedImageUrl,
          ...(resolvedImageList || []),
          stableImageUrl,
          ...(stableImageList || []),
        ]
      : [
          resolvedImageUrl,
          ...(resolvedImageList || []),
          stableImageUrl,
          ...(stableImageList || []),
          imageUrl,
          ...(imageList || []),
        ];

    const urls = orderedUrls
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);

    const uniqueUrls = Array.from(new Map<string, string>(
      urls
        .map((url): [string, string] => [normalizeCandidateIdentity(url), url])
        .filter(([key]) => Boolean(key))
    ).values());
    return uniqueUrls.length > 0 ? uniqueUrls : [DEFAULT_PLACEHOLDER];
  }, [
    imageList,
    imageUrl,
    preferImageUrl,
    resolvedImageList,
    resolvedImageUrl,
    stableImageList,
    stableImageUrl,
  ]);

  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
  }, [candidates]);

  const currentImage = (candidates[Math.min(activeIndex, candidates.length - 1)] || DEFAULT_PLACEHOLDER) as string;

  return (
    <img
      src={currentImage}
      alt={alt}
      referrerPolicy={referrerPolicy}
      loading={loading}
      decoding={decoding}
      fetchPriority={fetchPriority}
      className={className}
      draggable={false}
      onError={() => {
        setActiveIndex((prev) => (prev < candidates.length - 1 ? prev + 1 : prev));
      }}
    />
  );
};

export default NoteCoverImage;
