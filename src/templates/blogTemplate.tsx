import * as React from 'react'
import { graphql } from 'gatsby'
import styled from '@emotion/styled'
import { ThemeProps } from '@theme'
import Seo from '@/components/Seo'
import Layout from '@/components/Layout'
import { margin, padding } from 'polished'
// @ts-expect-error JS bc TS was annoying for some reason
import { getPageTitle } from '../../config'

const BlogPostWrapper = styled.div(({ theme }: ThemeProps) => ({
  ...padding('2rem', '2rem'),
  ...margin('0rem', '1rem'),
  backgroundColor: 'white',
  boxShadow: '4px 3px 8px 1px #969696',
  maxWidth: '72rem',
  height: '100%',
  h2: {
    marginTop: '1rem',
    marginBottom: '0.5rem',
    color: theme.colors.barstoolSecondary,
  },
  h3: {
    marginTop: '1rem',
  },
  p: {
    marginTop: '0.75rem',
    marginBottom: '0.75rem',
    color: theme.colors.uniformLeContrastInk,
  },
  li: {
    listStyle: 'disc',
    listStylePosition: 'inside',
  },
  a: {
    color: theme.colors.uniformElectric,
  },
}))

export default function Template({
  // @ts-expect-error untyped data
  data, // this prop will be injected by the GraphQL query below.
}) {
  const { markdownRemark } = data // data.markdownRemark holds your post data
  const { frontmatter, html } = markdownRemark
  return (
    <Layout>
      <Seo title={getPageTitle(`Bruden Blog | ${frontmatter.title}`)} />
      <BlogPostWrapper>
        <div className="blog-post">
          <h1>{frontmatter.title}</h1>
          <h2>{frontmatter.date}</h2>
          <div className="blog-post-content" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </BlogPostWrapper>
    </Layout>
  )
}

export const pageQuery = graphql`
  query ($slug: String!) {
    markdownRemark(frontmatter: { slug: { eq: $slug } }) {
      html
      frontmatter {
        date(formatString: "MMMM DD, YYYY")
        slug
        title
      }
    }
  }
`
