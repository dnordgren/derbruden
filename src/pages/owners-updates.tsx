import React from 'react'
import { Link } from 'gatsby'
import Layout from '@/components/Layout'
import Seo from '@/components/Seo'
import styled from '@emotion/styled'
import { ThemeProps } from '@theme'
import { padding } from 'polished'

const UpdatesWrapper = styled.div(({ theme }: ThemeProps) => ({
  ...padding('4rem', '4rem'),
  backgroundColor: 'white',
  boxShadow: '4px 3px 8px 1px #969696',
  h2: {
    marginTop: '1rem',
    marginBottom: '0.5rem',
  },
  li: {
    listStyle: 'disc',
    listStylePosition: 'inside',
  },
  a: {
    color: theme.colors.uniformElectric,
  }
}))

const OwnersUpdatesPage = () => {
  return (
    <Layout>
      <UpdatesWrapper>
        <Seo title="Owners Updates | Der Bruden" />
        <h1>Owners Updates - 2020</h1>
        <h2 id="2020-party">Fantasy Party Recap - Owner Voting</h2>
          <Link to="/league-updates/2020-year-end-votes">Read the Report</Link>
        <h2 id="w1">Week 1</h2>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w1-derek-1">Derek: It Begins</Link>
          </li>
        </ul>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w1-dalton-1">Dalton: Already foaming at the mouth</Link>
          </li>
        </ul>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w1-andy-1">Andy: The investigation of IBM Watson</Link>
          </li>
        </ul>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w1-jordan-1">Jordan: Smoldering forests</Link>
          </li>
        </ul>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w1-cole-1">Cole: Hare Krishna from The Little Engine That Couldn’t</Link>
          </li>
        </ul>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w1-alec-1">Alec: &quot;To conquer an enemy man must study&quot;</Link>
          </li>
        </ul>
        <h2 id="w3">Week 3</h2>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w3-derek-1">Derek: Rivalry Week</Link>
          </li>
        </ul>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w3-dalton-1">Dalton: Letters from Lt. Raunch of Denver, CO</Link>
          </li>
        </ul>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w3-andy-1">Andy: A Modest Proposal (1)</Link>
          </li>
        </ul>
        <h2 id="w4">Week 4</h2>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w4-derek-1">Derek: A Fantasy Haiku</Link>
          </li>
        </ul>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w4-dalton-1">Dalton: Thee Raunch One</Link>
          </li>
        </ul>
        <h2 id="w13">Week 13</h2>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w13-derek-1">Derek: Dusting off the updates</Link>
          </li>
        </ul>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w13-alec-1">Alec: A Pleasant Surprise</Link>
          </li>
        </ul>
        <ul>
          <li>
            <Link to="/owners-updates/2020-w13-andy-1">Andy: A Modest Proposal (2)</Link>
          </li>
        </ul>
      </UpdatesWrapper>
    </Layout>
  )
}

export default OwnersUpdatesPage
