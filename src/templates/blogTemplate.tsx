import React from 'react'
import { graphql } from 'gatsby'
import styled from '@emotion/styled'
import { ThemeProps } from '@theme'
import Layout from '@/components/Layout'

const BlogPostWrapper = styled.div(({ theme }: ThemeProps) => ({
  margin: '3rem',
  backgroundColor: theme.colors.light,
}))

export default function Template({
  // @ts-expect-error
  data, // this prop will be injected by the GraphQL query below.
}) {
  const { markdownRemark } = data // data.markdownRemark holds your post data
  const { frontmatter, html } = markdownRemark
  return (
    <Layout>
      <BlogPostWrapper>
        <div className="blog-post-container">
          <div className="blog-post">
            <h1>{frontmatter.title}</h1>
            <h2>{frontmatter.date}</h2>
            <div className="blog-post-content" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </div>
      </BlogPostWrapper>
    </Layout>
  )
}

export const pageQuery = graphql`
  query($slug: String!) {
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
