import React from 'react'
import styled from '@emotion/styled'
import { graphql, useStaticQuery } from 'gatsby'
import Img, { FluidObject } from 'gatsby-image'
import { padding } from 'polished'
import { ThemeProps } from '@theme'

const ImageWrapper = styled.div(({ theme }: ThemeProps) => ({
  width: '100%',
  maxWidth: '40rem',
  ...padding('0.5rem', '1.5rem'),
  border: `4px solid ${theme.colors.barstoolBlue}`,
  borderRadius: 8,
  boxShadow: theme.shadows.basic,
  backgroundColor: theme.colors.light,
}))

interface StaticImageQuery {
  file: {
    childImageSharp: {
      fluid: FluidObject
    }
  }
}

const StaticImage = () => {
  const data: StaticImageQuery = useStaticQuery(graphql`
    query {
      file(relativePath: { eq: "derbruden-the-shirt-21.png" }) {
        childImageSharp {
          fluid(maxWidth: 400, traceSVG: { color: "#141e30" }) {
            ...GatsbyImageSharpFluid_withWebp_tracedSVG
          }
        }
      }
    }
  `)

  return (
    <ImageWrapper>
      <a href="https://www.customink.com/g/wgw0-00cf-z5b3">
        <Img fluid={data.file.childImageSharp.fluid} alt="Bruden image showcase" />
      </a>
    </ImageWrapper>
  )
}

export default StaticImage
