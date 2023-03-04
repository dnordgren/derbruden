import * as React from 'react'
import { PageProps } from 'gatsby'
import Layout from '@/components/Layout'
import Seo from '@/components/Seo'
// @ts-expect-error JavaScript
import { getPageTitle } from '../../config'

const NotFoundPage = ({ location }: PageProps) => {
  return (
    <Layout>
      <Seo title={getPageTitle('Whoops, biffed it')}/>
      <h1>Error 404</h1>
      <p>Path &ldquo;{location.pathname}&rdquo; is not defined</p>
    </Layout>
  )
}

export default NotFoundPage
