/// <reference types="vite/client" />

declare module '*.css';

import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'moq-watch-ui': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      'moq-watch': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & {
        url?: string;
        name?: string;
        latency?: string;
        reload?: string;
      }, HTMLElement>;
      'moq-publish-ui': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      'moq-publish': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & {
        url?: string;
        name?: string;
        source?: string;
      }, HTMLElement>;
    }
  }
}
